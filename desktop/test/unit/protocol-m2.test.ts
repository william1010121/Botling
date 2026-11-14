// Botling 3 protocol, M2 additions (src/protocol): every new message round-trips; malformed and wrong-role frames are
// refused; a remote session never gets shell.*, content.open, content.find or any admin/machine command; every contract
// command has a scope; roster statements have one canonical encoding; content URLs and pairing links parse exactly.
import { describe, expect, it } from "vitest";
import { Command as ContractCommand, type Command, type CommandType } from "../../src/contract";
import {
  AddStatement, BINARY_FRAME_MARK, COMMAND_SCOPES, CONTENT_FRAME_CHUNK_LIMIT, CONTENT_TICKET_TTL_MS, DEFAULT_DEVICE_SCOPE, ENTRY_KINDS, Entry, FRAME_LIMIT,
  FrameSplitter, MACHINE_SETTINGS, MESSAGES, MemberId, PAIR_OFFER_TTL_MS, REMOTE_READS, ROLE_TABLE, RecoveryCode, SignedStatement, StatementBody,
  clusterIdFromRecoveryKey, commandScope, contentUrlForLog, contentUrlPath, decodeFrame, encodeChunkFrame, encodeFrame, fromBase64Url, memberIdFromKey,
  packFrame, pairLink, pairOfferExpired, parseContentUrl, parsePairLink, remoteCmdRefusal, remoteReqRefusal, roleRefusal, rosterDigest, statementBytes,
  statementId, toBase32, toBase64Url, type DeviceScope, type Message, type MessageOf, type PairOffer, type Sender, type SessionKind,
} from "../../src/protocol";
import { COMMAND_ROUTES } from "../../src/server/intents";
import { addDevice, addServer, botStream, cluster, contentId, device, endorse, hex, key, m2Samples, profile, revoke, root, reroot, serverA, serverB, statements, type M2Type, type Sample } from "./protocol-m2-samples";

const all = Object.entries(m2Samples) as [M2Type, Sample][];
const senders: Sender[] = ["fe", "server", "peer"];
const local: SessionKind = { local: true };
const remote: SessionKind = { local: false };
const pairing: SessionKind = { local: false, pairing: true };
const json = (value: unknown) => JSON.stringify(value);

function encode(sample: Sample, sender = sample.sender, session = sample.session ?? remote): string | Uint8Array {
  if (sample.message.t === "content.chunk") {
    const encoded = encodeChunkFrame(sample.message as MessageOf<"content.chunk">, sender, session);
    if (!encoded.ok) throw new Error(encoded.detail);
    return encoded.bytes;
  }
  const encoded = encodeFrame(sample.message, sender, session);
  if (!encoded.ok) throw new Error(encoded.detail);
  return encoded.text;
}
function refused(frame: string | Uint8Array, sender: Sender, session: SessionKind) {
  const decoded = decodeFrame(frame, sender, session);
  if (decoded.ok) throw new Error(`accepted: ${typeof frame === "string" ? frame.slice(0, 200) : "bytes"}`);
  return decoded;
}
const commandTypes = ContractCommand.options.map((option) => option.shape.type.value as CommandType).sort();

describe("protocol M2: round trips", () => {
  it("has a schema and a role row for every M2 message", () => {
    for (const type of Object.keys(m2Samples)) {
      expect(Object.hasOwn(MESSAGES, type), type).toBe(true);
      expect(ROLE_TABLE[type], type).toBeDefined();
    }
  });

  it.each(all)("%s round-trips through a frame", (_type, sample) => {
    const frame = encode(sample);
    const decoded = decodeFrame(frame, sample.sender, sample.session ?? remote);
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(decoded.message).toEqual(sample.message);
    if (typeof frame === "string") {
      const bytes = decodeFrame(new TextEncoder().encode(frame), sample.sender, sample.session ?? remote);
      expect(bytes.ok && bytes.message).toEqual(sample.message);
    }
  });

  it("round-trips text and binary frames over a byte stream cut at random places", () => {
    const sequence = all.filter(([, sample]) => !(sample.session ?? remote).pairing && (sample.session ?? remote).local === false && sample.sender !== "peer");
    const stream = sequence.flatMap(([, sample]) => [...packFrame(encode(sample))]);
    const bytes = new Uint8Array(stream);
    let seed = 11;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 20; run++) {
      const splitter = new FrameSplitter();
      const got: Message[] = [];
      for (let offset = 0; offset < bytes.length;) {
        const size = 1 + Math.floor(random() * 200);
        const pushed = splitter.push(bytes.subarray(offset, offset + size));
        if (!pushed.ok) throw new Error(pushed.detail);
        for (const frame of pushed.frames) {
          const [, sample] = sequence[got.length]!;
          const decoded = decodeFrame(frame, sample.sender, remote);
          if (!decoded.ok) throw new Error(decoded.detail);
          got.push(decoded.message);
        }
        offset += size;
      }
      expect(got).toEqual(sequence.map(([, sample]) => sample.message));
    }
  });

  it("sends a content chunk as raw bytes after a short header, never as JSON", () => {
    const sample = m2Samples["content.chunk"];
    const frame = encode(sample) as Uint8Array;
    expect(frame[0]).toBe(BINARY_FRAME_MARK);
    expect(frame.length).toBeLessThan(sample.message.bytes.length + 80);
    expect([...frame.subarray(frame.length - sample.message.bytes.length)]).toEqual([...sample.message.bytes]);
    expect(encodeFrame(sample.message, "server", remote)).toMatchObject({ ok: false, reason: "malformed" });
    const full = encodeChunkFrame({ ...sample.message, bytes: new Uint8Array(CONTENT_FRAME_CHUNK_LIMIT).fill(7) }, "server", remote);
    expect(full.ok && full.bytes.length).toBeLessThan(FRAME_LIMIT);
    // Uploads: a front end sends chunks too.
    const upload = encodeChunkFrame(sample.message, "fe", remote);
    expect(upload.ok && decodeFrame(upload.bytes, "fe", remote).ok).toBe(true);
  });

  it("knows the M2 entry kinds", () => {
    for (const kind of ["content.variant", "content.text", "content.changed", "content.ready"]) expect(ENTRY_KINDS.has(kind), kind).toBe(true);
    const hash = hex("1");
    const entry = (kind: string, body: Record<string, unknown>) => Entry.safeParse({ stream: botStream, logId: "logAAAAAAAAA", seq: 1, hlc: { ms: 1, c: 0 }, kind, body, hash });
    expect(entry("content.variant", { id: contentId, variant: { name: "poster", id: `sha256:${"0a".repeat(32)}`, size: 40_000, type: "image/jpeg", height: 360 } }).success).toBe(true);
    expect(entry("content.text", { id: contentId, pages: 100, textId: `sha256:${"0b".repeat(32)}` }).success).toBe(true);
    expect(entry("content.variant", { id: contentId, variant: { name: "poster" } }).success).toBe(false);
    expect(entry("content.text", { id: contentId, pages: -1, textId: contentId }).success).toBe(false);
    expect(entry("content.text", { id: contentId, pages: 3, text: "the text itself" }).success).toBe(false);
  });
});

describe("protocol M2: wrong-role frames are refused", () => {
  it.each(all)("%s is refused from every sender its row does not allow", (type, sample) => {
    const row = ROLE_TABLE[type]!;
    for (const sender of senders) {
      if (row[sender]) continue;
      const frame = type === "content.chunk" ? encode(sample, "server") : json(sample.message);
      const decoded = refused(frame, sender, sample.session ?? remote);
      expect(decoded.reason, `${type} from ${sender}`).toBe("role");
      expect(decoded.bye).toMatchObject({ t: "bye", reason: "role" });
    }
  });

  it("follows §5.4 for content, and opens uploads", () => {
    const may = (type: string, sender: Sender) => roleRefusal(type, sender, remote) === null;
    expect([may("content.get", "fe"), may("content.get", "server"), may("content.get", "peer")]).toEqual([true, false, true]);
    expect([may("content.meta", "fe"), may("content.meta", "server"), may("content.gone", "fe")]).toEqual([false, true, false]);
    expect([may("content.ticket", "fe"), may("content.ticket", "peer"), may("content.granted", "server"), may("content.granted", "fe")]).toEqual([true, false, true, false]);
    expect([may("content.put", "fe"), may("content.put", "peer"), may("content.stored", "server"), may("content.stored", "fe")]).toEqual([true, false, true, false]);
    expect([may("content.chunk", "fe"), may("content.credit", "server")]).toEqual([true, true]);
    expect([may("roster.statements", "fe"), may("roster.statements", "server"), may("roster.statements", "peer")]).toEqual([false, false, true]);
  });

  it("carries pair.* only in a pairing session, and a pairing session nothing else", () => {
    for (const type of ["pair.hello", "pair.added", "pair.ack", "pair.declined"] as const) {
      const sample = m2Samples[type];
      expect(refused(json(sample.message), sample.sender, remote).reason, type).toBe("role");
      expect(refused(json(sample.message), sample.sender, local).reason, type).toBe("role");
    }
    expect(refused(json(m2Samples["pair.hello"].message), "server", pairing).reason).toBe("role");
    expect(refused(json(m2Samples["pair.added"].message), "fe", pairing).reason).toBe("role");
    expect(refused(json(m2Samples["content.get"].message), "fe", pairing).reason).toBe("role");
    expect(refused(json({ t: "req", req: "r", cmd: { type: "chat.snapshot" } }), "fe", pairing).reason).toBe("role");
    expect(refused(json({ t: "pair.join" }), "fe", pairing).reason).toBe("unsupported");
  });

  it("keeps admin requests on the local socket", () => {
    expect(refused(json(m2Samples.admin.message), "fe", remote).reason).toBe("role");
    expect(refused(json(m2Samples["admin.event"].message), "server", remote).reason).toBe("role");
    expect(refused(json(m2Samples.admin.message), "peer", local).reason).toBe("role");
  });

  it("opens req/res to remote front ends, never to peers", () => {
    const req = { t: "req", req: "r1", cmd: { type: "chat.snapshot" } };
    expect(decodeFrame(json(req), "fe", remote).ok).toBe(true);
    expect(decodeFrame(json({ t: "res", req: "r1", ok: true, result: null }), "server", remote).ok).toBe(true);
    expect(refused(json(req), "peer", remote).reason).toBe("role");
    expect(refused(json(req), "server", remote).reason).toBe("role");
  });

  it("refuses shell.*, content.open and content.find on a remote session", () => {
    const shell = ["shell.screenshot", "shell.browser", "shell.install", "shell.quit"].map((t) => [{ t, req: "s1" }, "server"] as const);
    const frames: (readonly [unknown, Sender])[] = [
      ...shell,
      [{ t: "shell.done", req: "s1", ok: true }, "fe"],
      [{ t: "content.open", req: "c1", owner: serverA, id: contentId, variant: "original", entry: { stream: botStream, seq: 7 } }, "fe"],
      [{ t: "content.find", req: "c0", botId: "6A0B0000-0000-4000-8000-000000000002", line: "m2", url: "file:///clip.mp4" }, "fe"],
      [{ t: "content.file", req: "c1", id: contentId, path: "/x", type: "video/mp4", pin: "clone", sig: { size: 1, mtimeNs: "1", ino: "1" } }, "server"],
    ];
    for (const [message, sender] of frames) {
      expect(decodeFrame(json(message), sender, local).ok, (message as Message).t).toBe(true);
      expect(refused(json(message), sender, remote).reason, (message as Message).t).toBe("role");
    }
  });
});

describe("protocol M2: malformed frames are refused", () => {
  const bad: [string, Sender, SessionKind, unknown][] = [
    ["a get with a pending id", "fe", remote, { ...m2Samples["content.get"].message, id: `pending:${"0f".repeat(16)}` }],
    ["a get without the entry", "fe", remote, { ...m2Samples["content.get"].message, entry: undefined }],
    ["a get of zero bytes", "fe", remote, { ...m2Samples["content.get"].message, length: 0 }],
    ["a get of a variant with a slash", "fe", remote, { ...m2Samples["content.get"].message, variant: "../x" }],
    ["a meta with another chunk size", "server", remote, { ...m2Samples["content.meta"].message, chunkSize: 65_536 }],
    ["a chunk inside JSON", "server", remote, { t: "content.chunk", req: "g1", offset: 0, bytes: [1, 2, 3] }],
    ["a chunk as base64 text", "server", remote, { t: "content.chunk", req: "g1", offset: 0, bytes: "AQID" }],
    ["a credit of zero", "fe", remote, { ...m2Samples["content.credit"].message, bytes: 0 }],
    ["a credit above the limit", "fe", remote, { ...m2Samples["content.credit"].message, bytes: 2 ** 40 }],
    ["a ticket that is too short", "server", remote, { ...m2Samples["content.granted"].message, ticket: "abc" }],
    ["a put above 500 MB", "fe", remote, { ...m2Samples["content.put"].message, size: 500_000_001 }],
    ["an empty put", "fe", remote, { ...m2Samples["content.put"].message, size: 0 }],
    ["a pair.hello with a short key", "fe", pairing, { ...m2Samples["pair.hello"].message, sign: "abc" }],
    ["a pair.hello with a 31-byte key", "fe", pairing, { ...m2Samples["pair.hello"].message, sign: toBase64Url(new Uint8Array(31)) }],
    ["a pair.hello with a non-canonical key", "fe", pairing, { ...m2Samples["pair.hello"].message, sign: `${key(1).slice(0, 42)}B` }],
    ["a pair.added carrying a server's Add", "server", pairing, { ...m2Samples["pair.added"].message, add: addServer }],
    ["a pair.added carrying a Revoke", "server", pairing, { ...m2Samples["pair.added"].message, add: revoke }],
    ["a pair.declined with an unknown reason", "fe", pairing, { t: "pair.declined", reason: "because" }],
    ["roster.revocations with an Add", "peer", remote, { t: "roster.revocations", statements: [revoke, addDevice] }],
    ["roster.statements with an unsigned statement", "peer", remote, { t: "roster.statements", statements: [{ body: addDevice.body, signer: serverA }] }],
    ["an Add signed by someone else", "peer", remote, { t: "roster.statements", statements: [{ ...addDevice, signer: device }] }],
    ["a Root signed by a member", "peer", remote, { t: "roster.statements", statements: [{ ...root, signer: serverA }] }],
    ["an Add signed by the recovery key", "peer", remote, { t: "roster.statements", statements: [{ ...addDevice, signer: "recovery" }] }],
    ["a device Add without scope", "peer", remote, { t: "roster.statements", statements: [{ ...addDevice, body: { ...addDevice.body, scope: undefined } }] }],
    ["a device Add with admin scope", "peer", remote, { t: "roster.statements", statements: [{ ...addDevice, body: { ...addDevice.body, scope: ["read", "admin"] } }] }],
    ["a server Add with a scope", "peer", remote, { t: "roster.statements", statements: [{ ...addServer, body: { ...addServer.body, scope: ["manage"] } }] }],
    ["a gen-1 Root with a prev", "peer", remote, { t: "roster.statements", statements: [{ ...root, body: { ...root.body, prev: hex("f") } }] }],
    ["a gen-2 Root without prev", "peer", remote, { t: "roster.statements", statements: [{ ...reroot, body: { ...reroot.body, prev: null } }] }],
    ["a Revoke that cascades to its own member", "peer", remote, { t: "roster.statements", statements: [{ ...revoke, body: { ...revoke.body, cascade: [serverB] } }] }],
    ["a member id with upper case", "peer", remote, { t: "roster.statements", statements: [{ ...endorse, body: { ...endorse.body, member: device.toUpperCase() } }] }],
    ["a short signature", "peer", remote, { t: "roster.statements", statements: [{ ...profile, sig: "x" }] }],
    ["an admin op that is unknown", "fe", local, { t: "admin", req: "a1", op: { op: "roster.wipe" } }],
    ["an admin event with a 5-digit code", "server", local, { t: "admin.event", event: { kind: "pair.code", offer: "offer-0123456789ab", code: "12345", deviceId: device, deviceName: "Phone" } }],
  ];

  it.each(bad)("refuses %s", (_name, sender, session, value) => {
    const decoded = refused(json(value), sender, session);
    expect(decoded.reason).toBe("malformed");
    expect(decoded.bye).toMatchObject({ t: "bye", reason: "malformed" });
  });

  it("refuses broken binary frames", () => {
    const good = encode(m2Samples["content.chunk"]) as Uint8Array;
    const header = (text: string, tail: number[] = [1]) => new Uint8Array([BINARY_FRAME_MARK, text.length >> 8, text.length & 0xff, ...new TextEncoder().encode(text), ...tail]);
    expect(refused(good.subarray(0, 2), "server", remote).reason).toBe("malformed");
    expect(refused(new Uint8Array([BINARY_FRAME_MARK, 0xff, 0xff, 1]), "server", remote).reason).toBe("malformed");
    expect(refused(header("not json"), "server", remote).reason).toBe("malformed");
    expect(refused(header(json({ t: "live", stream: botStream })), "server", remote).reason).toBe("malformed");
    expect(refused(header(json({ t: "content.chunk", req: "g", offset: 0 }), []), "server", remote).reason).toBe("malformed");
    expect(refused(header(json({ t: "content.chunk", req: "g", offset: 0, bytes: [1] })), "server", remote).reason).toBe("malformed");
    expect(refused(header(json({ t: "content.chunk", req: "g", offset: -1 })), "server", remote).reason).toBe("malformed");
    expect(refused(header(json({ t: "content.chunk", req: "g", offset: 0 }), new Array(CONTENT_FRAME_CHUNK_LIMIT + 1).fill(0)), "server", remote).reason).toBe("malformed");
    expect(refused(new Uint8Array(FRAME_LIMIT + 1).fill(BINARY_FRAME_MARK), "server", remote).reason).toBe("too-large");
  });
});

describe("protocol M2: scopes", () => {
  it("gives every contract command a scope", () => {
    expect(Object.keys(COMMAND_SCOPES).sort()).toEqual(commandTypes);
    expect(Object.keys(COMMAND_ROUTES).sort()).toEqual(commandTypes);
  });

  it("agrees with the server's routes: app commands are machine, reads never mutate, the core set is not read", () => {
    for (const type of commandTypes) {
      const route = COMMAND_ROUTES[type].kind;
      const scope = COMMAND_SCOPES[type];
      if (route === "app") expect(scope, type).toBe("machine");
      if (route === "read") expect(["read", "admin", "machine"], type).toContain(scope);
      if (route === "intent") expect(["reply", "approve", "manage"], type).toContain(scope);
    }
  });

  it("lists only reads in the remote read allowlist, the 2.x phone page's among them", () => {
    for (const type of REMOTE_READS) expect(COMMAND_SCOPES[type], type).toBe("read");
    expect(REMOTE_READS.has("chat.snapshot") && REMOTE_READS.has("chat.history")).toBe(true);
  });

  const sampleCommand = (type: CommandType): Command | null => {
    const candidates: Record<string, unknown>[] = [
      { type }, { type, botId: "b1" }, { type, botId: "b1", text: "x" }, { type, change: { key: "appTheme", value: "dark" } },
    ];
    for (const candidate of candidates) {
      const parsed = ContractCommand.safeParse(candidate);
      if (parsed.success) return parsed.data;
    }
    return null;
  };

  it("refuses every admin and machine command on a remote session, as cmd and as req, whatever its scopes", () => {
    const everything: DeviceScope[] = ["read", "reply", "approve", "manage"];
    let checked = 0;
    for (const type of commandTypes) {
      const scope = COMMAND_SCOPES[type];
      if (scope !== "admin" && scope !== "machine") continue;
      const cmd = { type } as Command;
      expect(remoteCmdRefusal(cmd, everything), type).toMatch(/desktop window/);
      expect(remoteReqRefusal(cmd, everything), type).toMatch(/desktop window/);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    for (const type of ["mobile.pair", "machines.add", "files.pick", "updates.restart", "settings.get", "project.files", "attachment.file", "agy.runtime.install"] as CommandType[]) {
      expect(remoteCmdRefusal({ type } as Command, everything), type).not.toBeNull();
    }
    // A sample with real arguments where the contract has an easy one, to be sure no argument changes the answer.
    for (const type of commandTypes.filter((t) => COMMAND_SCOPES[t] === "machine" || COMMAND_SCOPES[t] === "admin")) {
      const cmd = sampleCommand(type);
      if (cmd) expect(remoteReqRefusal(cmd, everything), type).not.toBeNull();
    }
  });

  it("refuses a machine-security setting remotely, allows a plain one with manage", () => {
    const manage: DeviceScope[] = ["read", "reply", "approve", "manage"];
    for (const key of MACHINE_SETTINGS) {
      const cmd = { type: "settings.set", change: { key, value: true } } as Command;
      expect(commandScope(cmd), key).toBe("machine");
      expect(remoteCmdRefusal(cmd, manage), key).toMatch(/desktop window/);
    }
    for (const key of ["claudeBypassPermissions", "codexBypassPermissions", "agyBypassPermissions", "agyAcpPath"]) expect(MACHINE_SETTINGS.has(key as never), key).toBe(true);
    const theme = { type: "settings.set", change: { key: "appTheme", value: "dark" } } as Command;
    expect(remoteCmdRefusal(theme, manage)).toBeNull();
    expect(remoteCmdRefusal(theme, [...DEFAULT_DEVICE_SCOPE])).toMatch(/manage/);
  });

  it("checks a device's scopes for cmd and req", () => {
    const send = { type: "chat.send", botId: "b1", text: "hi" } as Command;
    const approve = { type: "component.approve" } as Command;
    const create = { type: "bots.create" } as Command;
    const snapshot = { type: "chat.snapshot" } as Command;
    expect(remoteCmdRefusal(send, ["read"])).toMatch(/reply/);
    expect(remoteCmdRefusal(send, [...DEFAULT_DEVICE_SCOPE])).toBeNull();
    expect(remoteCmdRefusal(approve, ["read", "reply"])).toMatch(/approve/);
    expect(remoteCmdRefusal(approve, [...DEFAULT_DEVICE_SCOPE])).toBeNull();
    expect(remoteCmdRefusal(create, [...DEFAULT_DEVICE_SCOPE])).toMatch(/manage/);
    expect(remoteCmdRefusal(snapshot, [...DEFAULT_DEVICE_SCOPE])).toMatch(/req/);
    expect(remoteReqRefusal(snapshot, ["read"])).toBeNull();
    expect(remoteReqRefusal(snapshot, ["reply"])).toMatch(/read/);
    expect(remoteReqRefusal(send, [...DEFAULT_DEVICE_SCOPE])).toMatch(/not a read/);
    expect(remoteReqRefusal({ type: "plugins.web" } as Command, [...DEFAULT_DEVICE_SCOPE])).toMatch(/not a read/);
  });
});

describe("protocol M2: roster statement encoding", () => {
  it("parses every sample statement and has one canonical form", async () => {
    for (const statement of statements) expect(SignedStatement.safeParse(statement).success, statement.body.type).toBe(true);
    const body = addDevice.body;
    const shuffled = Object.fromEntries(Object.entries(body).reverse()) as StatementBody;
    expect(statementBytes(shuffled)).toEqual(statementBytes(body));
    expect(new TextDecoder().decode(statementBytes(body))).toMatch(/^botling\/3 roster v1\n\{"at":/);
    const id = await statementId(body);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await statementId(shuffled)).toBe(id);
    expect(await statementId({ ...body, name: "Phone!" } as StatementBody)).not.toBe(id);
    const ids = await Promise.all(statements.map((s) => statementId(s.body)));
    expect(new Set(ids).size).toBe(statements.length);
  });

  it("signs and verifies the canonical bytes with Ed25519 (WebCrypto)", async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    const by = await memberIdFromKey(raw);
    expect(MemberId.safeParse(by).success).toBe(true);
    const body = AddStatement.parse({ ...addDevice.body, by });
    const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, statementBytes(body) as Uint8Array<ArrayBuffer>));
    const statement = SignedStatement.parse({ body, signer: by, sig: toBase64Url(signature) });
    const back = fromBase64Url(statement.sig)!;
    expect(await subtle.verify({ name: "Ed25519" }, pair.publicKey, back as Uint8Array<ArrayBuffer>, statementBytes(statement.body) as Uint8Array<ArrayBuffer>)).toBe(true);
    const altered = statementBytes({ ...body, scope: ["read", "reply", "approve", "manage"] });
    expect(await subtle.verify({ name: "Ed25519" }, pair.publicKey, back as Uint8Array<ArrayBuffer>, altered as Uint8Array<ArrayBuffer>)).toBe(false);
  });

  it("derives member ids, cluster ids and the roster digest", async () => {
    const raw = new Uint8Array(32).fill(1);
    const id = await memberIdFromKey(raw);
    expect(id).toMatch(/^[a-z2-7]{26}$/);
    expect(await memberIdFromKey(raw)).toBe(id);
    expect(await memberIdFromKey(new Uint8Array(32).fill(2))).not.toBe(id);
    await expect(memberIdFromKey(new Uint8Array(31))).rejects.toThrow(RangeError);
    const clusterId = await clusterIdFromRecoveryKey(raw);
    expect(clusterId).toMatch(/^[0-9a-f]{32}$/);
    expect(clusterId).not.toBe(cluster);
    expect(await rosterDigest(["b", "a", "b"])).toBe(await rosterDigest(["a", "b"]));
    expect(await rosterDigest(["a"])).not.toBe(await rosterDigest(["a", "b"]));
    // RFC 4648 base32 vectors (lower case, no padding).
    expect(toBase32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
    expect(toBase32(new TextEncoder().encode("f"))).toBe("my");
  });

  it("accepts a recovery code as typed and nothing else", () => {
    const code = "ABCD EFGH IJKL MNOP QRST UVWX YZ";
    expect(RecoveryCode.parse(code)).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(RecoveryCode.parse("abcd-efgh-ijkl-mnop-qrst-uvwx-yz")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(RecoveryCode.safeParse("ABCD EFGH").success).toBe(false);
    expect(RecoveryCode.safeParse("ABCDEFGHIJKLMNOPQRSTUVWXY1").success).toBe(false);
  });

  it("round-trips base64url and refuses non-canonical text", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 64]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + 11) & 0xff);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    expect(fromBase64Url("a")).toBeNull();
    expect(fromBase64Url("ab+/")).toBeNull();
    expect(fromBase64Url("AB")).toBeNull();
    expect(fromBase64Url("AA")).toEqual(new Uint8Array([0]));
  });
});

describe("protocol M2: content URL and ticket", () => {
  const ticket = toBase64Url(new Uint8Array(32).fill(13));
  const url = { owner: serverA, id: contentId, variant: "preview", entry: { stream: botStream, seq: 7 }, ticket };

  it("round-trips a content URL", () => {
    const path = contentUrlPath(url);
    expect(path.startsWith(`/v3/c/${serverA}/`)).toBe(true);
    expect(parseContentUrl(path)).toEqual(url);
    const { ticket: _ticket, ...bare } = url;
    expect(parseContentUrl(contentUrlPath(bare))).toEqual(bare);
    const dotted = { ...url, entry: { stream: "srv:a.b.c", seq: 12 } };
    expect(parseContentUrl(contentUrlPath(dotted))).toEqual(dotted);
    expect(CONTENT_TICKET_TTL_MS).toBe(600_000);
  });

  it("refuses anything that is not exactly a content URL", () => {
    const path = contentUrlPath(url);
    const bad = [
      path.replace("/v3/c/", "/v3/x/"),
      path.split("?")[0]!,
      path.replace("/preview?", "/preview/extra?"),
      path.replace("/preview?", "/..%2Fetc?"),
      path.replace(encodeURIComponent(contentId), "sha256%3Azz"),
      path.replace(serverA, "bad owner"),
      path.replace(/e=[^&]*/, "e=bot%3Ax.0"),
      path.replace(/e=[^&]*/, "e=nope"),
      path.replace(/e=[^&]*/, "e=bot%3Ax.01"),
      `${path}&x=1`,
      `${path}&t=${ticket}`,
      path.replace(ticket, "short"),
      path.replace(/e=[^&]*/, "e=%E0%A4%A"),
    ];
    for (const candidate of bad) expect(parseContentUrl(candidate), candidate).toBeNull();
  });

  it("never writes a ticket to a log", () => {
    const logged = contentUrlForLog(contentUrlPath(url));
    expect(logged).not.toContain(ticket);
    expect(logged).toContain("t=<ticket>");
    expect(contentUrlForLog(`/v3/c/x?t=${ticket}&e=y`)).not.toContain(ticket);
  });
});

describe("protocol M2: pairing offer link", () => {
  const offer: PairOffer = {
    v: 1, offer: "offer-0123456789ab", server: serverA, name: "Mac", keys: { sign: key(1), dh: key(2) }, cluster,
    secret: toBase64Url(new Uint8Array(32).fill(21)), expiresAt: 1_763_100_300_000, addresses: { tailnet: "https://machine.example.ts.net", relay: { url: "wss://relay.example", room: "room_1" } },
  };

  it("puts the offer in the fragment only, and reads it back", () => {
    const link = pairLink("https://machine.example.ts.net/v3/", offer);
    const [before, fragment] = link.split("#");
    expect(before).toBe("https://machine.example.ts.net/v3/");
    expect(before).not.toContain(offer.secret);
    expect(fragment!.startsWith("pair=")).toBe(true);
    expect(parsePairLink(link)).toEqual(offer);
    expect(parsePairLink(`#${fragment}`)).toEqual(offer);
    expect(PAIR_OFFER_TTL_MS).toBe(300_000);
    expect(pairOfferExpired(offer, offer.expiresAt - 1)).toBe(false);
    expect(pairOfferExpired(offer, offer.expiresAt)).toBe(true);
  });

  it("refuses malformed offers and links", () => {
    expect(() => pairLink("https://x/v3/", { ...offer, secret: "short" })).toThrow();
    expect(() => pairLink("https://x/v3/", { ...offer, addresses: {} })).toThrow();
    expect(parsePairLink("https://x/v3/")).toBeNull();
    expect(parsePairLink("https://x/v3/#pair=!!!")).toBeNull();
    expect(parsePairLink(`https://x/v3/#pair=${toBase64Url(new TextEncoder().encode("{}"))}`)).toBeNull();
    expect(parsePairLink(`https://x/v3/#pair=${toBase64Url(new TextEncoder().encode(json({ ...offer, extra: 1 })))}`)).toBeNull();
    expect(parsePairLink(`https://x/v3/#pair=${toBase64Url(new TextEncoder().encode(json({ ...offer, addresses: { tailnet: "http://plain" } })))}`)).toBeNull();
  });
});
