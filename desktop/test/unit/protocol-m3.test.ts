// Botling 3 wire protocol, M3 additions (src/protocol): table rows, preference gossip, server pairing and the
// forwarded-subscription tag. Every new message round-trips; wrong-role frames are refused; summary rows over the §8.2
// limits are refused; the role table stays total; M1/M2 decoders keep refusing M3 messages.
import { describe, expect, it } from "vitest";
import {
  AuditRow, BINARY_FRAME_MARK, FrameSplitter, JOIN_CODE_TRIES, JoinCode, M3_MESSAGES, MESSAGES, PrefRow, ROLE_TABLE, Rows, SUMMARY_LINE_CHARS,
  SummaryRow, TableRow, WIRE_MESSAGES, comparePrefVersions, decodeFrame, decodeWireFrame, encodeChunkFrame, encodeWireFrame, joinCodeFromBytes,
  joinLink, joinOfferExpired, memberFingerprint, mergePrefs, packFrame, parseJoinLink, prefsDigest, roleRefusal, tableOwner, toBase64Url,
  type JoinOffer, type M3MessageType, type SessionKind, type Sender, type SignedStatement, type WireMessage,
} from "../../src/protocol";
import { addDevice, addServer, botStream, cluster, contentId, endorse, hex, key, revoke, root, serverA, serverB, sig, statements } from "./protocol-m2-samples";

const local: SessionKind = { local: true };
const remote: SessionKind = { local: false };
const pairing: SessionKind = { local: false, pairing: true };
const senders: Sender[] = ["fe", "server", "peer"];
const json = (value: unknown) => JSON.stringify(value);
const srvB = `srv:${serverB}`;
const logB = "logBBBBBBBBB";
const hlc = (ms: number, c = 0) => ({ ms, c });

const summary: SummaryRow = {
  name: "Writer", face: { avatar: "circle", color: "#33AA77" }, role: "bot", parent: null, folderName: "notes", engine: "claude", model: "opus",
  status: "waiting", turn: { turnId: "t1", startedAt: 1_763_100_000_000 },
  waiting: [{ cardId: "card-1", cardRev: 2, kind: "approval", title: "Run tests?" }],
  unread: 3, lastAt: 1_763_100_001_000, lines: ["Done with step 1.", "Waiting for approval."],
  board: { blob: contentId, at: 1_763_100_000_500 }, usage: { today: { inputTokens: 1_200, outputTokens: 800 } },
};
const machine = { name: "server B", os: "linux", versions: { botling: "3.0.0", node: "24.1.0" }, addresses: ["ws://127.0.0.1:47001/v3/ws"], designated: false, pluginsDigest: hex("c") };
/** What M2's roster store writes (src/server/roster/store.ts `AuditBody`). */
const m2Audit = { act: "device.add", at: 1_763_100_000_000, statement: hex("a"), by: serverA, member: "dddddddddddddddddddddddddd", name: "Phone" };
const vapid = { publicKey: toBase64Url(new Uint8Array(65).fill(9).map((byte, index) => (index === 0 ? 4 : byte))), privateKey: key(21) };
/** N's Add of S (`join.done`): by N, member S. */
const addOfS: SignedStatement = { body: { type: "add", cluster, member: serverA, kind: "server", keys: { sign: key(31), dh: key(32) }, name: "server A", by: serverB, at: 1_763_100_000_000 }, signer: serverB, sig: sig(33) };
const prefRow: PrefRow = { key: "language", value: "zh-Hant", hlc: hlc(1_763_100_000_000, 1), writer: serverA };

type Sample = { message: WireMessage; sender: Sender; session: SessionKind };
const m3Samples: { [T in M3MessageType]: { message: Extract<WireMessage, { t: T }>; sender: Sender; session: SessionKind } } = {
  rows: {
    sender: "peer", session: remote, message: {
      t: "rows", stream: srvB, logId: logB, after: 4, to: 9, more: false, via: "fe-sub-1",
      rows: [
        { key: `bot:6A0B0000-0000-4000-8000-000000000002`, rev: 5, body: summary },
        { key: "machine", rev: 6, body: machine },
        { key: "settings", rev: 7, body: { language: "en", appTheme: "dark" } },
        { key: `audit:${hex("a")}`, rev: 8, body: m2Audit },
        { key: "bot:old-bot", rev: 9, deleted: true },
      ],
    },
  },
  "prefs.have": { sender: "peer", session: remote, message: { t: "prefs.have", digest: hex("d") } },
  "prefs.ids": { sender: "peer", session: remote, message: { t: "prefs.ids", versions: [{ key: "language", hlc: hlc(5, 1), writer: serverA }, { key: "followedBots", hlc: hlc(7), writer: serverB }] } },
  "prefs.want": { sender: "peer", session: remote, message: { t: "prefs.want", keys: ["language"] } },
  "prefs.rows": { sender: "peer", session: remote, message: { t: "prefs.rows", rows: [prefRow, { key: "followedBots", value: ["bot-1", "bot-2"], hlc: hlc(7), writer: serverB }, { key: "theme", value: null, hlc: hlc(8), writer: serverB }] } },
  "join.hello": { sender: "peer", session: pairing, message: { t: "join.hello", name: "server B", sign: key(41), proof: sig(42), version: "3.0.0", protocol: 1, cluster: null, members: 0 } },
  "join.code": { sender: "peer", session: pairing, message: { t: "join.code", code: "53RVXFK8" } },
  "join.wrong": { sender: "peer", session: pairing, message: { t: "join.wrong", left: 2 } },
  "join.checked": { sender: "peer", session: pairing, message: { t: "join.checked" } },
  "join.welcome": { sender: "peer", session: pairing, message: { t: "join.welcome", add: addServer, roster: statements, vapid, prefs: [prefRow] } },
  "join.done": { sender: "peer", session: pairing, message: { t: "join.done", add: addOfS } },
  "join.declined": { sender: "peer", session: pairing, message: { t: "join.declined", reason: "member" } },
};
const all = Object.entries(m3Samples) as [M3MessageType, Sample][];

function refused(frame: string | Uint8Array, sender: Sender, session: SessionKind) {
  const decoded = decodeWireFrame(frame, sender, session);
  if (decoded.ok) throw new Error(`accepted: ${typeof frame === "string" ? frame.slice(0, 200) : "bytes"}`);
  return decoded;
}
function accepted(value: unknown, sender: Sender, session: SessionKind) {
  const decoded = decodeWireFrame(json(value), sender, session);
  if (!decoded.ok) throw new Error(decoded.detail);
  return decoded.message;
}
const rowsOf = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ t: "rows", stream: srvB, logId: logB, after: 0, to: 20, more: false, rows, ...extra });
const botRow = (body: unknown, rev = 1) => ({ key: "bot:b1", rev, body });

describe("protocol M3: registries and the role table", () => {
  it("has a sample, a schema and a role row for every M3 message, apart from M1/M2's", () => {
    expect(Object.keys(m3Samples).sort()).toEqual(Object.keys(M3_MESSAGES).sort());
    for (const type of Object.keys(M3_MESSAGES)) {
      expect(Object.hasOwn(MESSAGES, type), type).toBe(false);
      expect(ROLE_TABLE[type], type).toBeDefined();
    }
    expect(Object.keys(WIRE_MESSAGES).sort()).toEqual([...Object.keys(MESSAGES), ...Object.keys(M3_MESSAGES)].sort());
  });

  it("keeps the role table total: every row is a message with a schema, or fetch.* (M5)", () => {
    for (const type of Object.keys(WIRE_MESSAGES)) {
      const row = ROLE_TABLE[type]!;
      expect(row, type).toBeDefined();
      expect(row.fe || row.server || row.peer, type).toBe(true);
    }
    const withoutSchema = Object.keys(ROLE_TABLE).filter((type) => !Object.hasOwn(WIRE_MESSAGES, type));
    expect(withoutSchema.sort()).toEqual(["fetch.ask", "fetch.chunk", "fetch.denied", "fetch.done", "fetch.grant"]);
  });

  it("follows §5.4's server ↔ server column for what M3 forwards", () => {
    const may = (type: string, sender: Sender) => roleRefusal(type, sender, remote) === null;
    for (const type of ["sub", "unsub", "ack", "history", "cmd", "cancel"]) expect([type, may(type, "fe"), may(type, "peer"), may(type, "server")]).toEqual([type, true, true, false]);
    for (const type of ["batch", "snap", "reset", "stale", "history.page", "held", "cmd.result", "cmd.retry", "content.meta", "content.gone", "rows"]) {
      expect([type, may(type, "fe"), may(type, "server"), may(type, "peer")]).toEqual([type, false, true, true]);
    }
    for (const type of ["content.get", "content.credit", "content.cancel", "content.chunk"]) expect([type, may(type, "peer")]).toEqual([type, true]);
    for (const type of ["prefs.have", "prefs.ids", "prefs.want", "prefs.rows", "roster.have", "roster.statements"]) {
      expect([type, may(type, "fe"), may(type, "server"), may(type, "peer")]).toEqual([type, false, false, true]);
    }
    expect([may("peer", "peer"), may("content.ticket", "peer"), may("content.put", "peer"), may("req", "peer")]).toEqual([false, false, false, false]);
  });
});

describe("protocol M3: round trips", () => {
  it.each(all)("%s round-trips through a frame", (_type, sample) => {
    const encoded = encodeWireFrame(sample.message, sample.sender, sample.session);
    if (!encoded.ok) throw new Error(encoded.detail);
    const decoded = decodeWireFrame(encoded.text, sample.sender, sample.session);
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(decoded.message).toEqual(sample.message);
    const bytes = decodeWireFrame(new TextEncoder().encode(encoded.text), sample.sender, sample.session);
    expect(bytes.ok && bytes.message).toEqual(sample.message);
  });

  it("round-trips the peer session's frames over a byte stream cut at random places", () => {
    const forwarded: Sample[] = [
      { sender: "peer", session: remote, message: { t: "sub", stream: botStream, cursor: { logId: logB, seq: 3 }, via: "fe-sub-1" } },
      { sender: "peer", session: remote, message: { t: "ack", stream: botStream, cursor: { logId: logB, seq: 4 }, via: "fe-sub-1" } },
      { sender: "peer", session: remote, message: { t: "unsub", stream: botStream, via: "fe-sub-1" } },
      { sender: "peer", session: remote, message: { t: "snap", stream: botStream, logId: logB, seq: 4, hash: hex("4"), view: { messages: [] }, via: "fe-sub-1" } },
      { sender: "peer", session: remote, message: { t: "reset", stream: botStream, logId: logB, retired: [{ logId: "logAAAAAAAAA", keptSeq: 2 }], reason: "restored", via: "fe-sub-1" } },
    ];
    const sequence = [...all.map(([, sample]) => sample).filter((sample) => !sample.session.pairing), ...forwarded];
    const bytes = new Uint8Array(sequence.flatMap((sample) => {
      const encoded = encodeWireFrame(sample.message, sample.sender, sample.session);
      if (!encoded.ok) throw new Error(encoded.detail);
      return [...packFrame(encoded.text)];
    }));
    let seed = 13;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 20; run++) {
      const splitter = new FrameSplitter();
      const got: WireMessage[] = [];
      for (let offset = 0; offset < bytes.length;) {
        const size = 1 + Math.floor(random() * 300);
        const pushed = splitter.push(bytes.subarray(offset, offset + size));
        if (!pushed.ok) throw new Error(pushed.detail);
        for (const frame of pushed.frames) {
          const decoded = decodeWireFrame(frame, "peer", remote);
          if (!decoded.ok) throw new Error(decoded.detail);
          got.push(decoded.message);
        }
        offset += size;
      }
      expect(got).toEqual(sequence.map((sample) => sample.message));
    }
  });

  it("reads binary content chunks from a peer with the wire decoder too", () => {
    const chunk = { t: "content.chunk", req: "g1", offset: 0, bytes: new Uint8Array([1, 2, 3]) } as const;
    const encoded = encodeChunkFrame(chunk, "peer", remote);
    if (!encoded.ok) throw new Error(encoded.detail);
    expect(encoded.bytes[0]).toBe(BINARY_FRAME_MARK);
    const decoded = decodeWireFrame(encoded.bytes, "peer", remote);
    expect(decoded.ok && decoded.message).toEqual(chunk);
  });

  it("sends rows to front ends without the forwarding tag", () => {
    const { via: _via, ...toFe } = m3Samples.rows.message;
    expect(accepted(toFe, "server", remote)).toEqual(toFe);
    expect(accepted(rowsOf([]), "server", local)).toMatchObject({ t: "rows", rows: [] });
  });
});

describe("protocol M3: M1/M2 decoders are unchanged", () => {
  it.each(all)("decodeFrame refuses %s as unsupported (an M3 message)", (_type, sample) => {
    const decoded = decodeFrame(json(sample.message), sample.sender, sample.session);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.reason).toBe("unsupported");
      expect(decoded.bye.reason).toBe("role");
    }
  });

  it("still refuses fetch.* as unsupported with the wire decoder", () => {
    expect(refused(json({ t: "fetch.ask", req: "f1" }), "peer", remote).reason).toBe("unsupported");
    expect(refused(json({ t: "fetch.ask", req: "f1" }), "fe", remote).reason).toBe("role");
  });
});

describe("protocol M3: wrong-role frames are refused", () => {
  it.each(all)("%s is refused from every sender its row does not allow", (type, sample) => {
    const row = ROLE_TABLE[type]!;
    for (const sender of senders) {
      if (row[sender]) continue;
      for (const session of [sample.session, local, remote]) {
        const decoded = refused(json(sample.message), sender, session);
        expect(decoded.reason, `${type} from ${sender}`).toBe("role");
        expect(decoded.bye).toMatchObject({ t: "bye", reason: "role" });
      }
      expect(encodeWireFrame(sample.message, sender, sample.session).ok).toBe(false);
    }
  });

  it("ends a device's session when it sends roster.*, prefs.*, join.* or a peer-only frame", () => {
    const peerOnly: unknown[] = [
      { t: "roster.have", digest: hex("b") }, { t: "roster.ids", ids: [] }, { t: "roster.want", ids: [] },
      { t: "roster.statements", statements: [addDevice] }, { t: "roster.revocations", statements: [revoke, root] },
      ...all.filter(([type]) => !ROLE_TABLE[type]!.fe).map(([, sample]) => sample.message),
    ];
    for (const message of peerOnly) {
      for (const session of [remote, pairing, local]) {
        const decoded = refused(json(message), "fe", session);
        expect(decoded.reason, json(message).slice(0, 60)).toBe("role");
        expect(decoded.bye.reason).toBe("role");
      }
    }
  });

  it("refuses admin and local-socket messages from a peer", () => {
    const admin = { t: "admin", req: "a1", op: { op: "devices.list" } };
    for (const session of [local, remote, pairing]) expect(refused(json(admin), "peer", session).reason).toBe("role");
    expect(refused(json({ t: "content.open", req: "o1", owner: serverA, id: contentId, variant: "original", entry: { stream: botStream, seq: 1 } }), "peer", local).reason).toBe("role");
    expect(refused(json({ t: "peer", serverId: serverA, state: "live", since: null }), "peer", remote).reason).toBe("role");
  });

  it("carries join.* only in a pairing session, and a pairing session nothing but pair.*, join.*, ping and bye", () => {
    for (const [type, sample] of all.filter(([type]) => type.startsWith("join."))) {
      expect(refused(json(sample.message), "peer", remote).reason, type).toBe("role");
      expect(refused(json(sample.message), "peer", local).reason, type).toBe("role");
      expect(refused(json(sample.message), "server", pairing).reason, type).toBe("role");
    }
    expect(refused(json(m3Samples["prefs.have"].message), "peer", pairing).reason).toBe("role");
    expect(refused(json({ t: "sub", stream: botStream, cursor: null }), "peer", pairing).reason).toBe("role");
    expect(refused(json(m3Samples.rows.message), "peer", pairing).reason).toBe("role");
    expect(decodeWireFrame(json({ t: "ping" }), "peer", pairing).ok).toBe(true);
    expect(decodeWireFrame(json({ t: "bye", reason: "closing" }), "peer", pairing).ok).toBe(true);
    expect(refused(json({ t: "join.offer" }), "peer", pairing).reason).toBe("malformed");
  });

  it("takes the forwarding tag only from a peer server", () => {
    const sub = { t: "sub", stream: botStream, cursor: null, via: "fe-sub-1" };
    expect(accepted(sub, "peer", remote)).toEqual(sub);
    expect(refused(json(sub), "fe", remote).reason).toBe("role");
    expect(refused(json(sub), "fe", local).reason).toBe("role");
    expect(refused(json({ t: "ack", stream: botStream, cursor: { logId: logB, seq: 1 }, via: "x" }), "fe", remote).reason).toBe("role");
    const snap = { t: "snap", stream: botStream, logId: logB, seq: 1, hash: hex("1"), view: {}, via: "fe-sub-1" };
    expect(accepted(snap, "peer", remote)).toEqual(snap);
    expect(refused(json(snap), "server", remote).reason).toBe("role");
    expect(refused(json(m3Samples.rows.message), "server", remote).reason).toBe("role");
    // The M1/M2 decoder applies the same rule; a sub without the tag is as before.
    expect(decodeFrame(json(sub), "fe", local).ok).toBe(false);
    expect(decodeFrame(json(sub), "peer", remote).ok).toBe(true);
    expect(decodeFrame(json({ t: "sub", stream: botStream, cursor: null }), "fe", local).ok).toBe(true);
    expect(refused(json({ ...sub, via: "bad tag" }), "peer", remote).reason).toBe("malformed");
  });
});

describe("protocol M3: summary rows and rows batches", () => {
  it("accepts a summary at the §8.2 limits", () => {
    const full = { ...summary, waiting: Array.from({ length: 5 }, (_, i) => ({ cardId: `c${i}`, cardRev: i, kind: "question", title: "Pick one" })), lines: ["x".repeat(SUMMARY_LINE_CHARS), "y", "z"] };
    expect(SummaryRow.safeParse(full).success).toBe(true);
    expect(SummaryRow.safeParse({ ...summary, turn: undefined, board: undefined, usage: undefined, face: null, folderName: null, model: null, lastAt: null, status: "idle", waiting: [], lines: [] }).success).toBe(true);
  });

  const over: [string, Record<string, unknown>][] = [
    ["six waiting items", { waiting: Array.from({ length: 6 }, (_, i) => ({ cardId: `c${i}`, cardRev: 0, kind: "approval", title: "t" })) }],
    ["four lines", { lines: ["a", "b", "c", "d"] }],
    ["a line of 141 characters", { lines: ["x".repeat(SUMMARY_LINE_CHARS + 1)] }],
    ["a folder path", { folderName: "/projects/notes" }],
    ["a Windows folder path", { folderName: "C:\\notes" }],
    ["an unknown status", { status: "sleeping" }],
    ["an unknown field", { messages: [] }],
    ["a long waiting title", { waiting: [{ cardId: "c", cardRev: 0, kind: "approval", title: "t".repeat(201) }] }],
    ["too many usage counters", { usage: { today: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) } }],
    ["a row over the size cap", { name: "n".repeat(200), waiting: Array.from({ length: 5 }, (_, i) => ({ cardId: `c${i}`.padEnd(64, "x"), cardRev: 0, kind: "k".repeat(40), title: "t".repeat(200) })), lines: ["l".repeat(140), "l".repeat(140), "l".repeat(140)], usage: { today: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`counter-${i}`.padEnd(40, "x"), 1e15])) } }],
  ];
  it.each(over)("refuses a summary with %s, in a rows frame as malformed", (_name, change) => {
    const body = { ...summary, ...change };
    expect(SummaryRow.safeParse(body).success).toBe(false);
    const decoded = refused(json(rowsOf([botRow(body)])), "peer", remote);
    expect(decoded.reason).toBe("malformed");
    expect(decoded.bye.reason).toBe("malformed");
  });

  it("checks other rows against their keys", () => {
    expect(TableRow.safeParse({ key: "settings", rev: 1, body: { language: "en" } }).success).toBe(true);
    for (const secret of ["apiKey", "relayToken", "vapidPrivateKey", "password", "recoveryCode", "clientSecret"]) {
      expect(TableRow.safeParse({ key: "settings", rev: 1, body: { [secret]: "x" } }).success, secret).toBe(false);
    }
    expect(TableRow.safeParse({ key: "machine", rev: 1, body: machine }).success).toBe(true);
    expect(TableRow.safeParse({ key: "machine", rev: 1, body: { ...machine, addresses: Array(11).fill("ws://127.0.0.1:1") } }).success).toBe(false);
    expect(AuditRow.safeParse(m2Audit).success).toBe(true);
    expect(AuditRow.safeParse({ act: "server.join", at: 1, by: serverA, member: serverB }).success).toBe(true);
    expect(AuditRow.safeParse({ act: "Server Join", at: 1 }).success).toBe(false);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 1, body: machine }).success).toBe(false);
    // Plan change N4: a row of a kind this version does not know is kept (only its key's form and size are checked).
    expect(TableRow.safeParse({ key: "other", rev: 1, body: {} }).success).toBe(true);
    expect(TableRow.safeParse({ key: "Other", rev: 1, body: {} }).success).toBe(false);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 0, body: summary }).success).toBe(false);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 1, deleted: true }).success).toBe(true);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 1, deleted: true, body: summary }).success).toBe(false);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 1 }).success).toBe(false);
    expect(TableRow.safeParse({ key: "bot:b1", rev: 1, deleted: false, body: summary }).success).toBe(false);
  });

  const badBatches: [string, unknown][] = [
    ["revs not rising", rowsOf([botRow(summary, 3), { key: "machine", rev: 2, body: machine }])],
    ["a rev at after", rowsOf([botRow(summary, 5)], { after: 5 })],
    ["a rev above to", rowsOf([botRow(summary, 21)])],
    ["a key twice", rowsOf([botRow(summary, 1), botRow(summary, 2)])],
    ["after above to", rowsOf([], { after: 21 })],
    ["a bot stream", rowsOf([], { stream: botStream })],
    ["no more flag", { ...rowsOf([]), more: undefined }],
    ["501 rows", rowsOf(Array.from({ length: 501 }, (_, i) => ({ key: `bot:b${i}`, rev: i + 1, deleted: true })), { to: 501 })],
  ];
  it.each(badBatches)("refuses a rows batch with %s", (_name, batch) => {
    expect(Rows.safeParse(batch).success).toBe(false);
    expect(refused(json(batch), "server", remote).reason).toBe("malformed");
  });

  it("takes a batch cut into parts and an empty catch-up", () => {
    expect(accepted(rowsOf([botRow(summary, 3)], { after: 2, to: 9, more: true }), "peer", remote)).toMatchObject({ more: true });
    expect(accepted(rowsOf([{ key: "machine", rev: 9, body: machine }], { after: 2, to: 9 }), "peer", remote)).toMatchObject({ more: false });
    expect(accepted(rowsOf([], { after: 9, to: 9 }), "peer", remote)).toMatchObject({ rows: [] });
    expect(tableOwner(srvB)).toBe(serverB);
    expect(tableOwner(botStream)).toBeNull();
  });
});

describe("protocol M3: preferences", () => {
  it("orders writes by (hlc, writer) and merges to the maximum whatever the order", () => {
    expect(comparePrefVersions({ hlc: hlc(1, 0), writer: "b" }, { hlc: hlc(2, 0), writer: "a" })).toBeLessThan(0);
    expect(comparePrefVersions({ hlc: hlc(2, 1), writer: "a" }, { hlc: hlc(2, 0), writer: "z" })).toBeGreaterThan(0);
    expect(comparePrefVersions({ hlc: hlc(2, 1), writer: "a" }, { hlc: hlc(2, 1), writer: "b" })).toBeLessThan(0);
    expect(comparePrefVersions({ hlc: hlc(2, 1), writer: "a" }, { hlc: hlc(2, 1), writer: "a" })).toBe(0);
    let seed = 5;
    const random = (n: number) => Math.floor(((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31) * n);
    for (let run = 0; run < 200; run++) {
      const rows: PrefRow[] = Array.from({ length: 12 }, () => ({ key: ["language", "theme", "followedBots"][random(3)]!, value: random(100), hlc: hlc(random(4), random(3)), writer: [serverA, serverB][random(2)]! }));
      const shuffled = [...rows].sort(() => random(3) - 1);
      const split = random(rows.length);
      const one = mergePrefs([], rows);
      const two = mergePrefs(mergePrefs([], shuffled.slice(0, split)).values(), mergePrefs(shuffled.slice(split), shuffled).values());
      const versions = (map: Map<string, PrefRow>) => [...map.values()].map((row) => [row.key, row.hlc, row.writer]).sort();
      expect(versions(two)).toEqual(versions(one));
      for (const row of rows) expect(comparePrefVersions(one.get(row.key)!, row)).toBeGreaterThanOrEqual(0);
    }
  });

  it("digests versions independently of order", async () => {
    const versions = [{ key: "language", hlc: hlc(5, 1), writer: serverA }, { key: "theme", hlc: hlc(6), writer: serverB }];
    const digest = await prefsDigest(versions);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await prefsDigest([...versions].reverse())).toBe(digest);
    expect(await prefsDigest([versions[0]!, { ...versions[1]!, hlc: hlc(6, 1) }])).not.toBe(digest);
  });

  it("refuses malformed preference frames", () => {
    expect(refused(json({ t: "prefs.rows", rows: [prefRow, prefRow] }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.rows", rows: [{ ...prefRow, value: undefined }] }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.rows", rows: [{ ...prefRow, value: "x".repeat(16_001) }] }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.rows", rows: [{ ...prefRow, key: "Language" }] }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.want", keys: ["a", "a"] }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.have", digest: "abc" }), "peer", remote).reason).toBe("malformed");
    expect(refused(json({ t: "prefs.ids", versions: [{ key: "language", hlc: hlc(1) }] }), "peer", remote).reason).toBe("malformed");
  });
});

describe("protocol M3: server pairing", () => {
  const offer: JoinOffer = {
    v: 1, offer: "join-0123456789abcd", server: serverB, name: "server B", keys: { sign: key(41), dh: key(43) }, secret: key(44),
    expiresAt: 1_763_100_300_000, addresses: ["ws://127.0.0.1:47001/v3/ws"],
  };

  it("reads typed codes forgivingly and makes codes it can read back", () => {
    expect(JoinCode.parse("53rv-xfk8")).toBe("53RVXFK8");
    expect(JoinCode.parse(" 53RV XFK8 ")).toBe("53RVXFK8");
    expect(JoinCode.parse("O1IL-0000")).toBe("0111" + "0000");
    for (const bad of ["53RV-XFK", "53RV-XFK8X", "53RU-XFK8", "", "53RV_XFK8"]) expect(JoinCode.safeParse(bad).success, bad).toBe(false);
    for (let fill = 0; fill < 256; fill += 17) {
      const code = joinCodeFromBytes(new Uint8Array([fill, 255 - fill, 7, fill, 1]));
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(JoinCode.parse(code)).toBe(code.replace("-", ""));
    }
    expect(joinCodeFromBytes(new Uint8Array(5))).toBe("0000-0000");
    expect(() => joinCodeFromBytes(new Uint8Array(4))).toThrow();
  });

  it("puts the offer in a link, never the code", () => {
    const link = joinLink(offer);
    expect(link.startsWith("botling-join:")).toBe(true);
    expect(parseJoinLink(link)).toEqual(offer);
    expect(parseJoinLink(`  ${link}\n`)).toEqual(offer);
    expect(parseJoinLink("botling-join:@@@")).toBeNull();
    expect(parseJoinLink(link.replace("botling-join:", "https://x/#pair="))).toBeNull();
    expect(() => joinLink({ ...offer, addresses: [] })).toThrow();
    expect(() => joinLink({ ...offer, addresses: ["http://127.0.0.1:1"] })).toThrow();
    expect(joinOfferExpired(offer, offer.expiresAt - 1)).toBe(false);
    expect(joinOfferExpired(offer, offer.expiresAt)).toBe(true);
  });

  it("shows a fingerprint made from the member id", () => {
    expect(memberFingerprint(serverB)).toBe("BBBB BBBB BBBB BBBB BBBB BBBB BB");
    expect(() => memberFingerprint("not-a-member")).toThrow();
  });

  const bad: [string, unknown][] = [
    ["a welcome with a device's Add", { ...m3Samples["join.welcome"].message, add: addDevice }],
    ["a welcome with no statements", { ...m3Samples["join.welcome"].message, roster: [] }],
    ["a welcome with a compressed VAPID key", { ...m3Samples["join.welcome"].message, vapid: { ...vapid, publicKey: toBase64Url(new Uint8Array(65).fill(2)) } }],
    ["a welcome with a short VAPID private key", { ...m3Samples["join.welcome"].message, vapid: { ...vapid, privateKey: "abc" } }],
    ["a done with an Endorse", { t: "join.done", add: endorse }],
    ["a wrong code with no tries left", { t: "join.wrong", left: 0 }],
    ["a wrong code with every try left", { t: "join.wrong", left: JOIN_CODE_TRIES }],
    ["a malformed code", { t: "join.code", code: "53RV" }],
    ["a hello with another protocol", { ...m3Samples["join.hello"].message, protocol: 2 }],
    ["a hello with a bad cluster", { ...m3Samples["join.hello"].message, cluster: "xyz" }],
    ["a checked with a field", { t: "join.checked", ok: true }],
    ["an unknown decline", { t: "join.declined", reason: "nope" }],
  ];
  it.each(bad)("refuses %s", (_name, message) => {
    expect(refused(json(message), "peer", pairing).reason).toBe("malformed");
  });
});
