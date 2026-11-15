// Botling 3 wire protocol + schema, M5-05: `fetch.*` messages on the wire (binary `fetch.chunk`, strict schemas,
// peer-only role checks) and the v11 migration adding §16 columns to `grants`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINARY_FRAME_MARK, CONTENT_FRAME_CHUNK_LIMIT, decodeFrame, decodeWireFrame, encodeChunkFrame, encodeWireFrame,
  FETCH_GRANT_BYTES_LIMIT, FETCH_MAX_BYTES, FETCH_MAX_FILES, FETCH_MESSAGES, FrameSplitter, packFrame, ROLE_TABLE,
  type Sender, type SessionKind, type WireMessage,
} from "../../src/protocol";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, openServerStore, schemaVersion, type ServerStore } from "../../src/server/store";
import { botStream, contentId, hex, serverA, serverB } from "./protocol-m2-samples";

const local: SessionKind = { local: true };
const remote: SessionKind = { local: false };
const pairing: SessionKind = { local: false, pairing: true };
const json = (value: unknown) => JSON.stringify(value);
const entry = { stream: botStream, seq: 3 };

const dirs: string[] = [];
const stores: ServerStore[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "botling-fetch-wire-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const askSamples: Array<WireMessage & { t: "fetch.ask" }> = [
  { t: "fetch.ask", fetchId: "fetch-1", requester: { bot: "bot-1" }, source: serverA, what: { kind: "path", path: "/srv/work/out.txt" }, purpose: "read output", maxBytes: 1024 },
  { t: "fetch.ask", fetchId: "fetch-2", requester: { device: "dev-1" }, source: serverB, what: { kind: "artifact", botId: "bot-2", path: "report.html" }, purpose: "", maxBytes: FETCH_MAX_BYTES },
  { t: "fetch.ask", fetchId: "fetch-3", requester: { bot: "bot-1" }, source: serverA, what: { kind: "blob", id: contentId, entry }, purpose: "inspect media", maxBytes: 1 },
  { t: "fetch.ask", fetchId: "fetch-4", requester: { bot: "bot-1" }, source: serverA, what: { kind: "git", path: "/srv/repo" }, purpose: "bundle", maxBytes: 4096 },
];

const jsonSamples: WireMessage[] = [
  ...askSamples,
  { t: "fetch.grant", fetchId: "fetch-1", prefix: "/srv/work", mode: "read", bytes: 1024, files: 1, expires: 1_763_100_000_000 },
  { t: "fetch.grant", fetchId: "fetch-2", prefix: "/srv/work/sub", mode: "read", bytes: FETCH_GRANT_BYTES_LIMIT, files: FETCH_MAX_FILES, expires: null },
  { t: "fetch.done", fetchId: "fetch-1", manifest: hex("f"), bytes: 0 },
  { t: "fetch.denied", fetchId: "fetch-1", reason: "denied" },
  { t: "fetch.denied", fetchId: "fetch-2", reason: "deny-list", detail: "keychain path" },
];

const chunkSample: WireMessage & { t: "fetch.chunk" } = {
  t: "fetch.chunk", fetchId: "fetch-1", index: 0, sha256: hex("c"), bytes: new Uint8Array([10, 20, 30, 40]),
};

describe("M5-05: fetch.* schemas and round-trips", () => {
  it("registers all five fetch.* schemas in FETCH_MESSAGES with peer-only role rows", () => {
    expect(Object.keys(FETCH_MESSAGES).sort()).toEqual(["fetch.ask", "fetch.chunk", "fetch.denied", "fetch.done", "fetch.grant"]);
    for (const type of Object.keys(FETCH_MESSAGES)) {
      expect(ROLE_TABLE[type]).toEqual({ fe: false, server: false, peer: true });
    }
  });

  it.each(jsonSamples)("$t round-trips through encodeWireFrame / decodeWireFrame", (message) => {
    const encoded = encodeWireFrame(message, "peer", remote);
    if (!encoded.ok) throw new Error(encoded.detail);
    const decoded = decodeWireFrame(encoded.text, "peer", remote);
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(decoded.message).toEqual(message);
  });

  it("round-trips fetch.chunk as a binary frame (0 to CONTENT_FRAME_CHUNK_LIMIT bytes)", () => {
    for (const size of [0, 4, 64 * 1024, CONTENT_FRAME_CHUNK_LIMIT]) {
      const msg: WireMessage & { t: "fetch.chunk" } = {
        ...chunkSample,
        index: size,
        bytes: new Uint8Array(size).fill(7),
      };
      const encoded = encodeChunkFrame(msg, "peer", remote);
      if (!encoded.ok) throw new Error(encoded.detail);
      expect(encoded.bytes[0]).toBe(BINARY_FRAME_MARK);
      const decoded = decodeWireFrame(encoded.bytes, "peer", remote);
      if (!decoded.ok) throw new Error(decoded.detail);
      expect(decoded.message).toEqual(msg);
    }
    expect(encodeWireFrame(chunkSample, "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("round-trips mixed JSON and binary fetch.* frames over FrameSplitter", () => {
    const frames: Uint8Array[] = [];
    for (const msg of jsonSamples) {
      const encoded = encodeWireFrame(msg, "peer", remote);
      if (!encoded.ok) throw new Error(encoded.detail);
      frames.push(packFrame(encoded.text));
    }
    const encodedChunk = encodeChunkFrame(chunkSample, "peer", remote);
    if (!encodedChunk.ok) throw new Error(encodedChunk.detail);
    frames.push(packFrame(encodedChunk.bytes));

    const stream = new Uint8Array(frames.flatMap((f) => [...f]));
    const splitter = new FrameSplitter();
    const got: WireMessage[] = [];
    for (let at = 0; at < stream.length; at += 173) {
      const pushed = splitter.push(stream.subarray(at, at + 173));
      if (!pushed.ok) throw new Error(pushed.detail);
      for (const raw of pushed.frames) {
        const decoded = decodeWireFrame(raw, "peer", remote);
        if (!decoded.ok) throw new Error(decoded.detail);
        got.push(decoded.message);
      }
    }
    expect(got).toEqual([...jsonSamples, chunkSample]);
  });

  it("refuses extra keys on every message and nested object (strict)", () => {
    for (const message of jsonSamples) {
      const decoded = decodeWireFrame(json({ ...message, extra: 1 }), "peer", remote);
      expect(decoded.ok, `${message.t} top-level extra`).toBe(false);
      if (!decoded.ok) expect(decoded.reason).toBe("malformed");
    }
    const extraRequester = { ...askSamples[0], requester: { bot: "bot-1", extra: true } };
    expect(decodeWireFrame(json(extraRequester), "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
    const bothRequester = { ...askSamples[0], requester: { bot: "bot-1", device: "dev-1" } };
    expect(decodeWireFrame(json(bothRequester), "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
    const extraWhat = { ...askSamples[0], what: { kind: "path", path: "/a", extra: 1 } };
    expect(decodeWireFrame(json(extraWhat), "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
    const extraEntry = { ...askSamples[2], what: { kind: "blob", id: contentId, entry: { ...entry, extra: 1 } } };
    expect(decodeWireFrame(json(extraEntry), "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });

    const badHeader = JSON.stringify({ t: "fetch.chunk", fetchId: "fetch-1", index: 0, sha256: hex("c"), extra: 1 });
    const badHeaderBytes = new TextEncoder().encode(badHeader);
    const frame = new Uint8Array([BINARY_FRAME_MARK, badHeaderBytes.length >> 8, badHeaderBytes.length & 0xff, ...badHeaderBytes, 1, 2]);
    expect(decodeWireFrame(frame, "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("enforces bounds on maxBytes, files, bytes, expires, paths, purpose, detail and chunk size", () => {
    const refuse = (value: unknown) => {
      const decoded = decodeWireFrame(json(value), "peer", remote);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.reason).toBe("malformed");
    };
    refuse({ ...askSamples[0], maxBytes: 0 });
    refuse({ ...askSamples[0], maxBytes: FETCH_MAX_BYTES + 1 });
    refuse({ ...askSamples[0], maxBytes: 1.5 });
    refuse({ ...askSamples[0], purpose: "p".repeat(501) });
    refuse({ ...askSamples[0], what: { kind: "path", path: "" } });
    refuse({ ...askSamples[0], what: { kind: "path", path: "a\0b" } });
    refuse({ ...askSamples[0], what: { kind: "path", path: "p".repeat(4_097) } });
    refuse({ ...askSamples[1], what: { kind: "artifact", botId: "bad id!", path: "r.html" } });

    refuse({ ...jsonSamples[4], prefix: "" });
    refuse({ ...jsonSamples[4], prefix: "/a\0b" });
    refuse({ ...jsonSamples[4], prefix: "p".repeat(4_097) });
    refuse({ ...jsonSamples[4], mode: "write" });
    refuse({ ...jsonSamples[4], files: -1 });
    refuse({ ...jsonSamples[4], files: FETCH_MAX_FILES + 1 });
    refuse({ ...jsonSamples[4], bytes: -1 });
    refuse({ ...jsonSamples[4], bytes: FETCH_GRANT_BYTES_LIMIT + 1 });
    refuse({ ...jsonSamples[4], expires: -1 });

    refuse({ t: "fetch.done", fetchId: "fetch-1", manifest: hex("f"), bytes: -1 });
    refuse({ t: "fetch.done", fetchId: "fetch-1", manifest: hex("f"), bytes: FETCH_GRANT_BYTES_LIMIT + 1 });
    refuse({ t: "fetch.done", fetchId: "fetch-1", manifest: "not-hex", bytes: 0 });

    refuse({ t: "fetch.denied", fetchId: "fetch-1", reason: "unknown" });
    refuse({ t: "fetch.denied", fetchId: "fetch-1", reason: "denied", detail: "d".repeat(501) });

    const tooBigChunk = { ...chunkSample, bytes: new Uint8Array(CONTENT_FRAME_CHUNK_LIMIT + 1).fill(1) };
    expect(encodeChunkFrame(tooBigChunk, "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
    const header = new TextEncoder().encode(JSON.stringify({ t: "fetch.chunk", fetchId: "fetch-1", index: 0, sha256: hex("c") }));
    const rawTooBig = new Uint8Array([BINARY_FRAME_MARK, header.length >> 8, header.length & 0xff, ...header, ...new Uint8Array(CONTENT_FRAME_CHUNK_LIMIT + 1)]);
    expect(decodeWireFrame(rawTooBig, "peer", remote)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("M5-05: role and decoder checks", () => {
  it("refuses fetch.* from front ends and server→FE with bye{role}, and refuses them in pairing sessions", () => {
    for (const sender of ["fe", "server"] as Sender[]) {
      for (const session of [local, remote]) {
        const decoded = decodeWireFrame(json(askSamples[0]), sender, session);
        expect(decoded).toMatchObject({ ok: false, reason: "role", bye: { t: "bye", reason: "role" } });
        expect(encodeWireFrame(askSamples[0], sender, session).ok).toBe(false);
        expect(encodeChunkFrame(chunkSample, sender, session)).toMatchObject({ ok: false, reason: "role" });
      }
    }
    expect(decodeWireFrame(json(askSamples[0]), "peer", pairing)).toMatchObject({ ok: false, reason: "role", bye: { t: "bye", reason: "role" } });
  });

  it("keeps decodeFrame (M1/M2) refusing fetch.* as unsupported", () => {
    expect(decodeFrame(json(askSamples[0]), "peer", remote)).toMatchObject({ ok: false, reason: "unsupported", bye: { t: "bye", reason: "role" } });
    const encodedChunk = encodeChunkFrame(chunkSample, "peer", remote);
    if (!encodedChunk.ok) throw new Error(encodedChunk.detail);
    expect(decodeFrame(encodedChunk.bytes, "peer", remote)).toMatchObject({ ok: false, reason: "unsupported", bye: { t: "bye", reason: "role" } });
  });
});

describe("M5-05: grants schema migration", () => {
  it("migrates an existing pre-M5 folder in place without dropping grants and adds the §16 columns", async () => {
    const dir = tempDir();
    const preM5 = await openServerStore(dir, { migrations: MIGRATIONS.slice(0, 11) });
    await preM5.submit((db) => {
      db.prepare("INSERT INTO grants (grantId, requester, prefix, mode, expires, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run("legacy-1", "bot-0", "/srv/old", "read", null, 1_000);
    });
    await preM5.close();

    const store = await openServerStore(dir);
    stores.push(store);
    expect(store.migrated).toEqual([12]);
    const reader = store.openReader();
    try {
      expect(schemaVersion(reader)).toBe(LATEST_SCHEMA_VERSION);
      const columns = (reader.prepare("PRAGMA table_info(grants)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toEqual([
        "grantId", "requester", "prefix", "mode", "expires", "createdAt",
        "requesterServer", "kind", "fetchId", "revokedAt",
      ]);
      expect(reader.prepare("SELECT grantId, requester, prefix, mode, expires, createdAt, requesterServer, kind, fetchId, revokedAt FROM grants WHERE grantId = ?").get("legacy-1"))
        .toEqual({
          grantId: "legacy-1", requester: "bot-0", prefix: "/srv/old", mode: "read", expires: null, createdAt: 1_000,
          requesterServer: "", kind: "always", fetchId: null, revokedAt: null,
        });
    } finally {
      reader.close();
    }

    await store.submit((db) => {
      db.prepare("INSERT INTO grants (grantId, requester, requesterServer, prefix, mode, kind, fetchId, expires, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("g-once", "bot-1", serverB, "/srv/work", "read", "once", "fetch-1", 2_000, 1_500, null);
      db.prepare("INSERT INTO grants (grantId, requester, requesterServer, prefix, mode, kind, fetchId, expires, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("g-always", "bot-1", serverB, "/srv/repo", "read", "always", null, null, 1_600, 1_700);
    });

    const checkReader = store.openReader();
    try {
      expect(checkReader.prepare("SELECT count(*) AS n FROM grants").get()).toEqual({ n: 3 });
    } finally {
      checkReader.close();
    }
  });

  it("migrates an empty pre-M5 grants table to the new columns", async () => {
    const dir = tempDir();
    const preM5 = await openServerStore(dir, { migrations: MIGRATIONS.slice(0, 11) });
    await preM5.close();

    const store = await openServerStore(dir);
    stores.push(store);
    expect(store.migrated).toEqual([12]);
    const reader = store.openReader();
    try {
      expect(schemaVersion(reader)).toBe(LATEST_SCHEMA_VERSION);
      const columns = (reader.prepare("PRAGMA table_info(grants)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toEqual([
        "grantId", "requester", "prefix", "mode", "expires", "createdAt",
        "requesterServer", "kind", "fetchId", "revokedAt",
      ]);
      expect(reader.prepare("SELECT count(*) AS n FROM grants").get()).toEqual({ n: 0 });
    } finally {
      reader.close();
    }
  });
});
