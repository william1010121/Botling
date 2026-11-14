// M2 step 9: content over the tailnet (protocol v1 §9A.4, §9A.7; brief Q1). Through the real loopback listener
// (127.0.0.1, port 0): `/v3/c/…` answers byte ranges exactly as M1's local path (the shared property test of
// main-v3-content-protocol.test.ts: sizes × Range headers × GET/HEAD × pin kinds), and refuses a request naming an entry
// that does not reference the id, another stream, an unreadable stream, a revoked device, an expired or unknown ticket.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewResponse } from "../../src/main/preview-response";
import { CHAT_MEDIA_CSP } from "../../src/main-v3/content-protocol";
import { CONTENT_CHUNK_BYTES, CONTENT_TICKET_TTL_MS, contentUrlPath, type DeviceScope, type EntryRef, type MessageOf, type StreamId } from "../../src/protocol";
import { ContentService, statSig, type LineLike } from "../../src/server/content";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { ensureStream, readStream } from "../../src/server/log";
import { LoopbackListener } from "../../src/server/net";
import { openServerStore, type ServerStore } from "../../src/server/store";

const MiB = CONTENT_CHUNK_BYTES;
const OWNER = "server-own";
const DEVICE = "device-a";
const ID = "sha256:" + "0".repeat(64);
const ENTRY: EntryRef = { stream: "bot:b1" as StreamId, seq: 3 };

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { x.copy(out, at); x = createHash("sha256").update(x).digest(); }
  return out;
}
function chunkHashes(data: Buffer): string {
  const digests: Buffer[] = [];
  for (let at = 0; at < data.length; at += MiB) digests.push(createHash("sha256").update(data.subarray(at, at + MiB)).digest());
  return Buffer.concat(digests).toString("base64");
}
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HEADERS = ["content-type", "content-range", "content-length", "accept-ranges", "content-security-policy", "cache-control", "x-content-type-options"];
async function answer(response: Response) {
  const headers: Record<string, string | null> = {};
  for (const name of HEADERS) headers[name] = response.headers.get(name);
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers, body: body.length ? createHash("sha256").update(body).digest("hex") + `:${body.length}` : null };
}
/** The same ranges as M1's property test. */
function ranges(size: number, next: () => number): Array<string | null> {
  const n = (max: number) => Math.floor(next() * (max + 1));
  const out: Array<string | null> = [null, "bytes=0-", "bytes=0-0", `bytes=${size}-`, `bytes=${Math.max(0, size - 1)}-`, "bytes=-1", `bytes=-${size + 10}`, "bytes=-0", "bytes=-", "bytes=5-2",
    `bytes=0-${size + 1000}`, "bytes=0-1,4-5", "items=0-1", "bytes= 0-1", "bytes=99999999999999999999-", `bytes=${MiB - 1}-${MiB}`, `bytes=${MiB}-`];
  for (let i = 0; i < 18; i++) {
    const a = n(size + 2);
    const b = n(size + 2);
    const pick = n(4);
    out.push(pick === 0 ? `bytes=${Math.min(a, b)}-${Math.max(a, b)}` : pick === 1 ? `bytes=${a}-` : pick === 2 ? `bytes=-${b}` : pick === 3 ? `bytes=${Math.max(a, b)}-${Math.min(a, b)}` : `bytes=${a}-${a + n(3 * MiB)}`);
  }
  return out;
}

let scratch: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "botling-content-remote-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

/** A roster of one device whose scope (or absence) the test sets. */
function roster(scope: DeviceScope[] | null = ["read", "reply", "approve"]) {
  const state = { scope };
  return { state, device: (member: string) => (member === DEVICE && state.scope ? { keys: { sign: "s", dh: "d" }, scope: state.scope } : null) };
}

async function listen(content: RemoteContent): Promise<string> {
  const listener = await LoopbackListener.start({ port: 0, remote: { accept: () => { throw new Error("no sessions here"); } }, pageDir: null, origins: () => [], log: () => undefined, content });
  cleanups.push(() => listener.close());
  return `http://127.0.0.1:${listener.port}`;
}

// -------------------------------------------------------------------------------------------------
describe("byte ranges: /v3/c/ answers exactly as M1's local path (the shared property test, over HTTP)", () => {
  it("status, headers and bytes match preview-response.ts for copies, hashed and unhashed `pin: path` files (GET and HEAD)", async () => {
    let file: MessageOf<"content.file"> | null = null;
    const service = {
      serverId: OWNER,
      locate: () => null,
      open: async () => file!,
      markChanged: async () => undefined,
    };
    const tickets = new ContentTickets();
    const origin = await listen(new RemoteContent({ service, tickets, roster: roster() }));
    const { ticket } = tickets.issue({ deviceId: DEVICE, owner: OWNER, id: ID, entry: ENTRY });
    const url = origin + contentUrlPath({ owner: OWNER, id: ID, variant: "original", entry: ENTRY, ticket });
    const next = random(13);
    const sizes = [0, 1, 2, 31, MiB - 1, MiB, MiB + 1, 3 * MiB + 12_345, 1 + Math.floor(next() * 2 * MiB)];
    let compared = 0;
    const statuses = new Set<number>();
    for (const size of sizes) {
      const path = join(scratch, `f-${size}.mp4`);
      const data = bytes(`s${size}`, size);
      writeFileSync(path, data);
      const files = (["copy", "path", "path"] as const).map((pin, i) => ({
        t: "content.file" as const, req: "r", id: ID, path, type: "video/mp4", pin, sig: statSig(path), ...(i === 1 && size ? { chunkHashes: chunkHashes(data) } : {}),
      }));
      for (const range of ranges(size, next)) {
        for (const method of ["GET", "HEAD"]) {
          const expected = await answer(await previewResponse(path, new Request("botling-chat://chat/attachment/x", { method, headers: range ? { range } : {} }), { type: "video/mp4", follow: false, csp: CHAT_MEDIA_CSP }));
          statuses.add(expected.status);
          for (const one of files) {
            file = one;
            const response = await fetch(url, { method, headers: range ? { range } : {} });
            expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
            const got = await answer(response);
            expect(got, `size ${size}, ${method} ${range ?? "(no range)"}, pin ${one.pin}${one.chunkHashes ? " hashed" : ""}`).toEqual(expected);
            compared += 1;
          }
        }
      }
    }
    expect([...statuses].sort()).toEqual([200, 206, 416]);
    expect(compared).toBeGreaterThan(sizes.length * 60);
  }, 120_000);
});

// -------------------------------------------------------------------------------------------------
describe("permission at serve time (§9A.7) and the ticket (Q1)", () => {
  const BOT = "b1";
  const STREAM = `bot:${BOT}` as StreamId;
  const OTHER = "bot:b2" as StreamId;
  let store: ServerStore;
  let service: ContentService;

  async function setup(options: Partial<ConstructorParameters<typeof ContentService>[0]> = {}, clock?: { now: number }) {
    const dataDir = join(scratch, "data");
    store = await openServerStore(dataDir);
    await store.submit((db) => { ensureStream(db, STREAM); ensureStream(db, OTHER); });
    service = new ContentService({ store, dataDir, serverId: store.meta("serverId")!, ...options });
    cleanups.push(async () => { await service.close(); await store.close(); });
    const tickets = new ContentTickets(clock ? { now: () => clock.now } : {});
    const devices = roster();
    const remote = new RemoteContent({ service, tickets, roster: devices });
    const origin = await listen(remote);
    return { tickets, devices, remote, origin, owner: service.serverId };
  }
  async function post(stream: StreamId, botId: string, line: LineLike) {
    const message = { id: line.id, role: "bot", text: line.text, time: "2026-11-15T00:00:00.000Z", state: "done" };
    const { entries, ready } = await service.appendLine(stream, botId, line, [{ kind: "message.added", body: { botId, message } }]);
    return { entry: entries[0]!, ready: await ready };
  }
  const locate = (remote: RemoteContent, botId: string, line: string, url: string, device = DEVICE) =>
    remote.locate(device, { t: "content.locate", req: "k1", botId, line, url });
  const get = (origin: string, path: string, range?: string) => fetch(origin + path, { headers: range ? { range } : {} });

  it("locate → a ticketed URL that serves the line's bytes; asking again renews the same ticket", async () => {
    const clock = { now: 1_000_000 };
    const { remote, origin, owner } = await setup({}, clock);
    const file = join(scratch, "clip.mp4");
    const data = bytes("clip", 2 * MiB + 5);
    writeFileSync(file, data);
    await post(STREAM, BOT, { id: "m1", text: `![c](${pathToFileURL(file).href})` });
    const located = await locate(remote, BOT, "m1", pathToFileURL(file).href);
    expect(located.ref).toMatchObject({ owner, state: "ready", type: "video/mp4", entry: { stream: STREAM } });
    expect(located.ref!.id).toMatch(/^sha256:/);
    expect(located.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(located.expiresAt).toBe(clock.now + CONTENT_TICKET_TTL_MS);
    const path = contentUrlPath({ owner, id: located.ref!.id, variant: "original", entry: located.ref!.entry, ticket: located.ticket });
    const response = await get(origin, path, `bytes=${MiB}-${MiB + 9}`);
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(data.subarray(MiB, MiB + 10))).toBe(true);
    clock.now += 5 * 60_000;
    const renewed = await remote.ticket(DEVICE, { t: "content.ticket", req: "k2", owner, id: located.ref!.id, entry: located.ref!.entry });
    expect(renewed).toEqual({ t: "content.granted", req: "k2", ticket: located.ticket, expiresAt: clock.now + CONTENT_TICKET_TTL_MS });
    // 9 minutes after the renewal (14 after the first ticket): still served.
    clock.now += 9 * 60_000;
    expect((await get(origin, path, "bytes=0-0")).status).toBe(206);
    // A line that names no indexed file, an unknown line: no reference, no ticket.
    expect(await locate(remote, BOT, "m1", "file:///elsewhere/other.mp4")).toEqual({ t: "content.located", req: "k1", ref: null });
    expect(await locate(remote, BOT, "nope", pathToFileURL(file).href)).toEqual({ t: "content.located", req: "k1", ref: null });
  });

  it("refuses: no ticket, an unknown ticket, an expired ticket, a malformed URL", async () => {
    const clock = { now: 5_000_000 };
    const { remote, origin, owner } = await setup({}, clock);
    const file = join(scratch, "a.png");
    writeFileSync(file, bytes("a", 5000));
    await post(STREAM, BOT, { id: "m1", text: `![a](${file})` });
    const located = await locate(remote, BOT, "m1", `file://${file}`);
    const parts = { owner, id: located.ref!.id, variant: "original", entry: located.ref!.entry };
    const reason = async (path: string) => { const r = await get(origin, path); return `${r.status} ${r.headers.get("x-botling-content") ?? ""}`; };
    expect(await reason(contentUrlPath(parts))).toBe("403 refused; reason=no-ticket");
    expect(await reason(contentUrlPath({ ...parts, ticket: "A".repeat(43) }))).toBe("403 refused; reason=ticket");
    expect(await reason(contentUrlPath({ ...parts, ticket: located.ticket }) + "&x=1")).toBe("404 refused; reason=malformed");
    expect(await reason(`/v3/c/${owner}/${encodeURIComponent(parts.id)}/original?t=${located.ticket}`)).toBe("404 refused; reason=malformed");
    expect((await get(origin, contentUrlPath({ ...parts, ticket: located.ticket }))).status).toBe(200);
    clock.now += CONTENT_TICKET_TTL_MS;
    expect(await reason(contentUrlPath({ ...parts, ticket: located.ticket }))).toBe("403 refused; reason=ticket");
  });

  it("refuses an entry that does not reference the id, another stream, an unreadable stream", async () => {
    const { remote, origin, owner, tickets } = await setup();
    const a = join(scratch, "a.png"), b = join(scratch, "b.png");
    writeFileSync(a, bytes("a", 5000)); writeFileSync(b, bytes("b", 6000));
    const lineA = await post(STREAM, BOT, { id: "m1", text: `![a](${a})` });
    const lineB = await post(STREAM, BOT, { id: "m2", text: `![b](${b})` });
    await post(OTHER, "b2", { id: "m9", text: `![b](${b})` });
    const refA = (await locate(remote, BOT, "m1", `file://${a}`)).ref!;
    const refB = (await locate(remote, BOT, "m2", `file://${b}`)).ref!;
    const status = async (id: string, entry: EntryRef, ticketEntry = entry) => {
      const { ticket } = tickets.issue({ deviceId: DEVICE, owner, id, entry: ticketEntry });
      const r = await get(origin, contentUrlPath({ owner, id, variant: "original", entry, ticket }));
      return `${r.status} ${r.headers.get("x-botling-content") ?? "ok"}`;
    };
    // a's id with b's line entry (which references b, not a): denied, also when asked as a ticket.
    expect(await status(refA.id, lineB.entry)).toBe("404 gone; reason=denied");
    expect(await remote.ticket(DEVICE, { t: "content.ticket", req: "k", owner, id: refA.id, entry: { stream: lineB.entry.stream, seq: lineB.entry.seq } }))
      .toEqual({ t: "content.gone", req: "k", id: refA.id, reason: "denied" });
    // b's id in another stream at the seq of b's line there? the entry names (stream, seq): b2's stream at m2's seq does not reference it.
    expect(await status(refB.id, { stream: OTHER, seq: lineB.entry.seq })).toBe("404 gone; reason=denied");
    // A ticket for a's entry used for another entry or stream: the binding does not match.
    expect(await status(refA.id, { stream: OTHER, seq: lineA.entry.seq }, refA.entry)).toBe("403 refused; reason=binding");
    expect(await status(refB.id, refA.entry, refB.entry)).toBe("403 refused; reason=binding");
    // A pending id is never opened remotely.
    expect(await status("pending:" + "0f".repeat(16), refA.entry)).toMatch(/^404 /);
    // The stream becomes unreadable (gone): the same ticket, the same entry, refused; locate answers nothing.
    expect(await status(refA.id, refA.entry)).toBe("200 ok");
    await store.submit((db) => { db.prepare("UPDATE streams SET state = 'gone' WHERE stream = ?").run(STREAM); });
    expect(readStream(store.openReader(), STREAM)?.state).toBe("gone");
    expect(await status(refA.id, refA.entry)).toBe("404 gone; reason=denied");
    expect((await locate(remote, BOT, "m1", `file://${a}`)).ref).toBeNull();
  });

  it("a revoked device (or one without `read`) is refused on its next request, and its tickets are dropped", async () => {
    const { remote, origin, owner, tickets, devices } = await setup();
    const a = join(scratch, "a.mp4");
    writeFileSync(a, bytes("a", 3 * MiB));
    await post(STREAM, BOT, { id: "m1", text: `![a](${pathToFileURL(a).href})` });
    const located = await locate(remote, BOT, "m1", pathToFileURL(a).href);
    const path = contentUrlPath({ owner, id: located.ref!.id, variant: "original", entry: located.ref!.entry, ticket: located.ticket });
    expect((await get(origin, path, "bytes=0-99")).status).toBe(206);
    devices.state.scope = ["reply"];
    expect((await get(origin, path, "bytes=0-99")).headers.get("x-botling-content")).toBe("refused; reason=device");
    expect(tickets.size).toBe(0);
    devices.state.scope = ["read"];
    const again = await locate(remote, BOT, "m1", pathToFileURL(a).href);
    devices.state.scope = null;
    const revoked = await get(origin, contentUrlPath({ owner, id: again.ref!.id, variant: "original", entry: again.ref!.entry, ticket: again.ticket }), "bytes=0-99");
    expect(`${revoked.status} ${revoked.headers.get("x-botling-content")}`).toBe("403 refused; reason=device");
    expect(await locate(remote, BOT, "m1", pathToFileURL(a).href)).toEqual({ t: "content.located", req: "k1", ref: null });
    expect(await remote.ticket(DEVICE, { t: "content.ticket", req: "k", owner, id: again.ref!.id, entry: again.ref!.entry })).toMatchObject({ t: "content.gone", reason: "denied" });
    // Another device's ticket never stands for this one.
    expect(tickets.dropDevice("device-b")).toBe(0);
  });

  it("`pin: path`: after the file is rewritten the old line answers 410 changed (and `content.changed` is appended), never the new bytes", async () => {
    const { remote, origin, owner } = await setup({ pin: { force: "path" } });
    const v = join(scratch, "big.mp4");
    const old = bytes("old", 2 * MiB + 3);
    writeFileSync(v, old);
    await post(STREAM, BOT, { id: "m1", text: `![v](${pathToFileURL(v).href})` });
    const located = await locate(remote, BOT, "m1", pathToFileURL(v).href);
    const path = contentUrlPath({ owner, id: located.ref!.id, variant: "original", entry: located.ref!.entry, ticket: located.ticket });
    expect(Buffer.from(await (await get(origin, path)).arrayBuffer()).equals(old)).toBe(true);
    const newer = bytes("new", 2 * MiB + 3);
    writeFileSync(v, newer);
    for (const range of ["bytes=0-", "bytes=0-1", undefined]) {
      const response = await get(origin, path, range);
      expect(response.status).toBe(410);
      expect(response.headers.get("x-botling-content")).toBe("gone; reason=changed");
      expect(Buffer.from(await response.arrayBuffer()).includes(newer.subarray(0, 64))).toBe(false);
    }
    const kinds = store.openReader().prepare("SELECT kind, body FROM entries WHERE stream = ? ORDER BY seq").all(STREAM).map((row) => String(row.kind));
    expect(kinds).toContain("content.changed");
    expect((await locate(remote, BOT, "m1", pathToFileURL(v).href)).ref).toMatchObject({ state: "changed" });
    expect((await locate(remote, BOT, "m1", pathToFileURL(v).href)).ticket).toBeUndefined();
  });
});

describe("ContentTickets", () => {
  it("binds a ticket to (device, owner, id, entry), renews it under the same text, forgets it when expired, keeps at most `limit`", () => {
    const clock = { now: 0 };
    const tickets = new ContentTickets({ now: () => clock.now, limit: 3 });
    const one = tickets.issue({ deviceId: "d1", owner: OWNER, id: ID, entry: ENTRY });
    expect(tickets.check(one.ticket)).toMatchObject({ deviceId: "d1", owner: OWNER, id: ID, entry: ENTRY });
    expect(tickets.issue({ deviceId: "d2", owner: OWNER, id: ID, entry: ENTRY }).ticket).not.toBe(one.ticket);
    expect(tickets.issue({ deviceId: "d1", owner: OWNER, id: ID, entry: { ...ENTRY, seq: 4 } }).ticket).not.toBe(one.ticket);
    clock.now = CONTENT_TICKET_TTL_MS - 1;
    expect(tickets.issue({ deviceId: "d1", owner: OWNER, id: ID, entry: ENTRY })).toEqual({ ticket: one.ticket, expiresAt: 2 * CONTENT_TICKET_TTL_MS - 1 });
    clock.now = 2 * CONTENT_TICKET_TTL_MS - 1;
    expect(tickets.check(one.ticket)).toBeNull();
    const fresh = tickets.issue({ deviceId: "d1", owner: OWNER, id: ID, entry: ENTRY });
    expect(fresh.ticket).not.toBe(one.ticket);
    for (let i = 0; i < 5; i++) tickets.issue({ deviceId: "d3", owner: OWNER, id: ID, entry: { ...ENTRY, seq: 10 + i } });
    expect(tickets.size).toBe(3);
    expect(tickets.check(fresh.ticket)).toBeNull();
  });
});
