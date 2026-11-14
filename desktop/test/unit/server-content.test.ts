// The content path's local part on the server (M1 step 13, protocol v1 §9A.2–§9A.4, §9A.7, D44): named files, pins,
// references in the entry's transaction, hashing in a worker thread, `content.find` / `content.open`, `changed`.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { ContentService, contentLineHook, finishedLine, Hasher, namedFiles, pathOfFileRef, pinFile, type LineLike } from "../../src/server/content";
import { EventTap, TxScope } from "../../src/server/effects";
import { appendEntries, ensureStream, readEntries } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";

const BOT = "bot-a";
const STREAM = `bot:${BOT}` as StreamId;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

let root: string;
let dataDir: string;
let media: string;
let store: ServerStore;
let service: ContentService;

function line(id: string, text: string, attachments: LineLike["attachments"] = []): LineLike {
  return { id, text, attachments };
}
const messageBody = (l: LineLike) => ({ botId: BOT, message: { id: l.id, role: "bot", text: l.text, time: "2026-11-14T00:00:00.000Z", state: "done" } });

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { x.copy(out, at); x = createHash("sha256").update(x).digest(); }
  return out;
}

async function openService(options: Partial<ConstructorParameters<typeof ContentService>[0]> = {}): Promise<ContentService> {
  return new ContentService({ store, dataDir, serverId: store.meta("serverId")!, ...options });
}

async function postLine(l: LineLike, svc = service) {
  const { entries, ready } = await svc.appendLine(STREAM, BOT, l, [{ kind: "message.added", body: messageBody(l) }]);
  return { entry: entries[0]!, ready };
}

const rows = (sql: string, ...params: Array<string | number>) => {
  const reader = store.openReader();
  try { return reader.prepare(sql).all(...params); } finally { reader.close(); }
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "botling-content-"));
  dataDir = join(root, "data");
  media = join(root, "media");
  mkdirSync(media, { recursive: true });
  store = await openServerStore(dataDir);
  await store.submit((db) => ensureStream(db, STREAM));
  service = await openService();
});

afterEach(async () => {
  await service.close();
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("named files", () => {
  it("reads file URLs, absolute Markdown targets and attachments; indexed kinds only; no protected files", () => {
    const text = [
      "![plot](file:///work/out/plot.png) and the video file:///work/out/clip%20one.mp4",
      "[report](/work/out/report.pdf) [data](/work/out/data.csv) [again](file:///work/out/plot.png)",
      "![key](/home/me/.ssh/id.png) [own](/srv/data/x.pdf)",
    ].join("\n");
    const found = namedFiles(line("m1", text, [{ url: "file:///work/in/photo.jpg", name: "photo.jpg" }]), { dataDir: "/srv/data" });
    expect(found.map((file) => [file.path, file.kind, file.type])).toEqual([
      ["/work/out/plot.png", "image", "image/png"],
      ["/work/out/clip one.mp4", "video", "video/mp4"],
      ["/work/out/report.pdf", "pdf", "application/pdf"],
      ["/work/in/photo.jpg", "image", "image/jpeg"],
    ]);
  });

  it("matches the renderer's file references to the same path", () => {
    expect(pathOfFileRef("file:///a/b%20c.mp4")).toBe("/a/b c.mp4");
    expect(pathOfFileRef("file:///a/b c.mp4")).toBe("/a/b c.mp4"); // `file://` + a raw path (localMediaSource)
    expect(pathOfFileRef("/a/./b.png")).toBe("/a/b.png");
    expect([pathOfFileRef("https://x/y.png"), pathOfFileRef("//host/y.png"), pathOfFileRef("pending:abc")]).toEqual([null, null, null]);
  });

  it("finishedLine takes a finished message.added/updated, never a streaming one", () => {
    const message = { id: "m1", role: "bot", text: "x", time: "t", state: "done" };
    expect(finishedLine({ type: "message.added", botId: BOT, message })?.line.id).toBe("m1");
    expect(finishedLine({ type: "message.updated", botId: BOT, message: { ...message, state: "streaming" } })).toBeNull();
    expect(finishedLine({ type: "turn.finished", botId: BOT })).toBeNull();
  });
});

describe("a finished line naming a video, a picture and a PDF", () => {
  it("gets content_refs and content_names in the entry's transaction, then content.ready with the hashes", async () => {
    const files = { video: join(media, "clip.mp4"), picture: join(media, "plot.png"), pdf: join(media, "report.pdf") };
    const data = { video: bytes("v", 3 * 1024 * 1024 + 17), picture: bytes("p", 40_000), pdf: Buffer.concat([Buffer.from("%PDF-1.7\n"), bytes("d", 90_000)]) };
    for (const key of Object.keys(files) as Array<keyof typeof files>) writeFileSync(files[key], data[key]);
    const l = line("m1", `![v](${pathToFileURL(files.video).href}) ![p](${files.picture}) [r](${pathToFileURL(files.pdf).href})`);

    // Hold hashing so the state right after the entry's commit can be read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hasher = new Hasher();
    const held = { hash: async (path: string) => { await gate; return hasher.hash(path); } } as unknown as Hasher;
    const svc = await openService({ hasher: held });
    const { entry, ready } = await postLine(l, svc);

    const names = rows("SELECT path, id FROM content_names WHERE stream = ? AND seq = ? ORDER BY path", STREAM, entry.seq);
    const refs = rows("SELECT id FROM content_refs WHERE stream = ? AND seq = ? ORDER BY id", STREAM, entry.seq);
    expect(names.length).toBe(3);
    expect(refs.map((row) => row.id).sort()).toEqual(names.map((row) => row.id).sort());
    expect(names.every((row) => String(row.id).startsWith("pending:"))).toBe(true);
    expect(rows("SELECT state FROM content").map((row) => row.state)).toEqual(["preparing", "preparing", "preparing"]);
    // The window can open a pending pin at once (bytes fixed when the line finished).
    const found = svc.find({ t: "content.find", req: "f1", botId: BOT, line: "m1", url: `file://${files.video}` });
    expect(found.ref?.state).toBe("preparing");
    const opened = await svc.open({ t: "content.open", req: "o1", owner: svc.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
    expect(opened.t).toBe("content.file");
    if (opened.t === "content.file") expect(readFileSync(opened.path).equals(data.video)).toBe(true);

    release();
    const readyEntries = await ready;
    expect(readyEntries.map((e) => e.kind)).toEqual(["content.ready", "content.ready", "content.ready"]);
    const byPath = new Map(readyEntries.map((e) => [String((e.body as { url: string }).url), e.body as { ref: { id: string; size: number; kind: string; state: string } }]));
    for (const key of Object.keys(files) as Array<keyof typeof files>) {
      const ref = byPath.get(pathToFileURL(files[key]).href)!.ref;
      expect(ref.id).toBe(sha(data[key]));
      expect(ref.size).toBe(data[key].length);
      expect(ref.state).toBe("ready");
    }
    expect(byPath.get(pathToFileURL(files.pdf).href)!.ref.kind).toBe("pdf");
    // The line's rows moved to the content ids; each content.ready entry references its id too.
    const after = rows("SELECT id, seq FROM content_refs WHERE stream = ? ORDER BY seq, id", STREAM);
    expect(after.filter((row) => Number(row.seq) === entry.seq).map((row) => row.id).sort()).toEqual([sha(data.pdf), sha(data.picture), sha(data.video)].sort());
    for (const e of readyEntries) expect(after.some((row) => Number(row.seq) === e.seq && row.id === (e.body as { ref: { id: string } }).ref.id)).toBe(true);
    expect(rows("SELECT count(*) AS n FROM content WHERE id LIKE 'pending:%'")[0]!.n).toBe(0);
    // A front end that got the pending id from content.find just before the hash was ready still opens it: the same
    // bytes, now as the content id, with the proof of reference the content id holds for the line's entry.
    const late = await svc.open({ t: "content.open", req: "o2", owner: svc.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
    expect(late).toMatchObject({ t: "content.file", req: "o2", id: found.ref!.id, type: "video/mp4" });
    if (late.t === "content.file") {
      expect(readFileSync(late.path).equals(data.video)).toBe(true);
      expect(late.sig.size).toBe(data.video.length);
    }
    expect(rows("SELECT id FROM content_aliases WHERE pending = ?", found.ref!.id).map((row) => row.id)).toEqual([sha(data.video)]);
    // The alias carries no proof of its own: another entry, or another line's pending id, is still refused.
    expect(await svc.open({ t: "content.open", req: "o3", owner: svc.serverId, id: found.ref!.id, variant: "original", entry: { stream: STREAM, seq: readyEntries[0]!.seq + 100 } }))
      .toMatchObject({ t: "content.gone", reason: "denied" });
    expect(await svc.open({ t: "content.open", req: "o4", owner: svc.serverId, id: "pending:0000", variant: "original", entry: found.ref!.entry }))
      .toMatchObject({ t: "content.gone", reason: "denied" });
    expect(svc.find({ t: "content.find", req: "f2", botId: BOT, line: "m1", url: `file://${files.video}` }).ref).toMatchObject({ id: sha(data.video), state: "ready", entry: found.ref!.entry });
    const chunkCount = rows("SELECT chunkHashes FROM content WHERE id = ?", sha(data.video)).map((row) => Buffer.from(String(row.chunkHashes), "base64").length / 32);
    expect(chunkCount).toEqual([4]);
    await svc.close();
    await hasher.close();
  });

  it("hashes in a worker thread: the event loop keeps turning while a file is hashed", async () => {
    const file = join(media, "big.mp4");
    writeFileSync(file, bytes("big", 48 * 1024 * 1024));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    const result = await service.hasher.hash(file);
    clearInterval(timer);
    expect(result.size).toBe(48 * 1024 * 1024);
    expect(result.id).toBe(sha(readFileSync(file)));
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("content.open checks the proof of reference", () => {
  it("refuses an id the named entry does not reference, another owner, a variant, and finds nothing for an unnamed file", async () => {
    const a = join(media, "a.png");
    const b = join(media, "b.png");
    writeFileSync(a, bytes("a", 1000));
    writeFileSync(b, bytes("b", 1000));
    const first = await postLine(line("m1", `![a](${a})`));
    const second = await postLine(line("m2", `![b](${b})`));
    await first.ready;
    await second.ready;
    const idA = sha(readFileSync(a));
    const idB = sha(readFileSync(b));
    const open = (id: string, seq: number, extra: Record<string, string> = {}) =>
      service.open({ t: "content.open", req: "o", owner: service.serverId, id, variant: "original", entry: { stream: STREAM, seq }, ...extra });
    expect((await open(idA, first.entry.seq)).t).toBe("content.file");
    expect(await open(idB, first.entry.seq)).toMatchObject({ t: "content.gone", reason: "denied" });
    expect(await open(idA, second.entry.seq)).toMatchObject({ t: "content.gone", reason: "denied" });
    expect(await service.open({ t: "content.open", req: "o", owner: service.serverId, id: idA, variant: "original", entry: { stream: "bot:other" as StreamId, seq: first.entry.seq } })).toMatchObject({ reason: "denied" });
    expect(await open(idA, first.entry.seq, { owner: "someone-else" })).toMatchObject({ reason: "offline" });
    expect(await open(idA, first.entry.seq, { variant: "poster" })).toMatchObject({ reason: "deleted" });
    expect(service.find({ t: "content.find", req: "f", botId: BOT, line: "m1", url: pathToFileURL(b).href }).ref).toBeNull();
    expect(service.find({ t: "content.find", req: "f", botId: BOT, line: "m2", url: pathToFileURL(b).href }).ref?.id).toBe(idB);
  });
});

describe("pinned versions", () => {
  it("pin: path — a rewritten file makes the old line answer gone{changed}, never the new bytes; the new line gets its own", async () => {
    await service.close();
    service = await openService({ pin: { force: "path" } });
    const file = join(media, "render.mp4");
    const v1 = bytes("v1", 2 * 1024 * 1024 + 5);
    writeFileSync(file, v1);
    const first = await postLine(line("m1", `![v](${file})`));
    const [ready] = await first.ready;
    const ref = (ready!.body as { ref: { id: string; pin: string } }).ref;
    expect(ref.pin).toBe("path");
    const open = (id: string, seq: number) => service.open({ t: "content.open", req: "o", owner: service.serverId, id, variant: "original", entry: { stream: STREAM, seq } });
    const before = await open(ref.id, first.entry.seq);
    expect(before.t).toBe("content.file");
    if (before.t === "content.file") expect(Buffer.from(before.chunkHashes!, "base64").length).toBe(3 * 32);

    const v2 = bytes("v2", 2 * 1024 * 1024 + 5);
    writeFileSync(file, v2);
    expect(await open(ref.id, first.entry.seq)).toMatchObject({ t: "content.gone", reason: "changed" });
    expect(await open(ref.id, first.entry.seq)).toMatchObject({ t: "content.gone", reason: "changed" });
    const changed = readEntries(store.openReader(), STREAM, 1, { maxEntries: 100, maxBytes: 1e9 }).entries.filter((e) => e.kind === "content.changed");
    expect(changed.map((e) => e.body)).toEqual([{ id: ref.id }]);
    expect(service.find({ t: "content.find", req: "f", botId: BOT, line: "m1", url: pathToFileURL(file).href }).ref?.state).toBe("changed");

    const second = await postLine(line("m2", `![v](${file})`));
    const [ready2] = await second.ready;
    const ref2 = (ready2!.body as { ref: { id: string } }).ref;
    expect(ref2.id).toBe(sha(v2));
    const now = await open(ref2.id, second.entry.seq);
    expect(now.t).toBe("content.file");
    if (now.t === "content.file") expect(readFileSync(now.path).equals(v2)).toBe(true);
    expect(await open(ref.id, first.entry.seq)).toMatchObject({ reason: "changed" });
  });

  it("pin: path — a file rewritten while it is hashed is changed, never ready", async () => {
    await service.close();
    const hasher = new Hasher();
    const file = join(media, "moving.mp4");
    writeFileSync(file, bytes("m1", 1024 * 1024));
    const racing = { hash: async (path: string) => { writeFileSync(file, bytes("m2", 1024 * 1024)); return hasher.hash(path); } } as unknown as Hasher;
    service = await openService({ pin: { force: "path" }, hasher: racing });
    const posted = await postLine(line("m1", `![v](${file})`));
    expect(await posted.ready).toEqual([]);
    expect(rows("SELECT state FROM content").map((row) => row.state)).toEqual(["changed"]);
    expect(service.find({ t: "content.find", req: "f", botId: BOT, line: "m1", url: pathToFileURL(file).href }).ref?.state).toBe("changed");
    await hasher.close();
  });

  it.runIf(process.platform === "darwin")("APFS: a rewrite leaves the old line's clone playable", async () => {
    const file = join(media, "clip.mp4");
    const v1 = bytes("c1", 5 * 1024 * 1024);
    writeFileSync(file, v1);
    const probe = await pinFile(file, join(root, "probe"));
    expect(probe.pin).toBe("clone"); // the OS temp folder is on the internal APFS disk
    const first = await postLine(line("m1", `![v](${file})`));
    const [ready] = await first.ready;
    const ref = (ready!.body as { ref: { id: string; pin: string } }).ref;
    expect(ref.pin).toBe("clone");
    writeFileSync(file, bytes("c2", 5 * 1024 * 1024)); // in place, same inode
    const opened = await service.open({ t: "content.open", req: "o", owner: service.serverId, id: ref.id, variant: "original", entry: { stream: STREAM, seq: first.entry.seq } });
    expect(opened.t).toBe("content.file");
    if (opened.t === "content.file") {
      expect(opened.pin).toBe("clone");
      expect(readFileSync(opened.path).equals(v1)).toBe(true);
    }
  });

  it("copies a small file when told to; the same bytes named twice keep one version", async () => {
    await service.close();
    service = await openService({ pin: { force: "copy" } });
    const a = join(media, "a.png");
    const b = join(media, "b.png");
    const same = bytes("same", 70_000);
    writeFileSync(a, same);
    writeFileSync(b, same);
    const first = await postLine(line("m1", `![a](${a})`));
    await first.ready;
    const second = await postLine(line("m2", `![b](${b})`));
    await second.ready;
    const content = rows("SELECT id, pin, path FROM content");
    expect(content.map((row) => [row.id, row.pin])).toEqual([[sha(same), "copy"]]);
    expect(readdirSync(service.pinsDir)).toEqual([String(content[0]!.path).split("/").pop()]);
    expect(rows("SELECT seq FROM content_refs WHERE id = ? ORDER BY seq", sha(same)).length).toBe(4); // two lines + two content.ready
  });
});

describe("recovery at start", () => {
  it("hashes again what was preparing and sweeps pins no row names", async () => {
    await service.close();
    const stalled = { hash: () => new Promise(() => {}) } as unknown as Hasher;
    const svc = await openService({ hasher: stalled });
    const file = join(media, "p.png");
    writeFileSync(file, bytes("p", 5000));
    const posted = await postLine(line("m1", `![p](${file})`), svc);
    void posted.ready;
    // The pin is recorded right after the entry's commit; then hashing stalls.
    for (let i = 0; i < 200 && rows("SELECT pin FROM content")[0]?.pin === "path"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rows("SELECT pin, state FROM content").map((row) => [row.pin, row.state])).toEqual([[process.platform === "darwin" ? "clone" : expect.any(String), "preparing"]]);
    writeFileSync(join(svc.pinsDir, "0123456789abcdef0123456789abcdef"), "orphan");
    writeFileSync(join(svc.pinsDir, "feedfeedfeedfeedfeedfeedfeedfeed.partial"), "partial");
    // The server stopped here (the hash never came back).
    service = await openService();
    const { swept, rehashed } = await service.recover();
    expect([swept, rehashed]).toEqual([2, 1]);
    expect(rows("SELECT id, state FROM content").map((row) => [row.id, row.state])).toEqual([[sha(readFileSync(file)), "ready"]]);
    expect(existsSync(join(service.pinsDir, "0123456789abcdef0123456789abcdef"))).toBe(false);
    const ready = readEntries(store.openReader(), STREAM, 1, { maxEntries: 100, maxBytes: 1e9 }).entries.filter((e) => e.kind === "content.ready");
    expect(ready.length).toBe(1);
  });
});

describe("on the event tap (step 6), and the line's later updates", () => {
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  it("a finished line the engine emits gets its references in the entry's transaction, then content.ready", async () => {
    const scope = new TxScope(store);
    const tap = new EventTap({ scope, hooks: { lineStored: contentLineHook(service, scope) } });
    const video = join(media, "out.mp4");
    const data = bytes("tap", 2 * 1024 * 1024 + 5);
    writeFileSync(video, data);
    const message = (state: string) => ({ id: "m7", role: "bot", text: `done ![v](${pathToFileURL(video).href})`, time: "2026-11-14T00:00:00.000Z", state });
    // While it streams: no reference. Its finishing update: references in the same transaction as that entry.
    tap.event({ type: "message.added", botId: BOT, message: message("streaming") } as never);
    await waitFor(() => tap.waiting === 0 && rows("SELECT count(*) AS n FROM entries WHERE stream = ? AND kind = 'message.added'", STREAM)[0]!.n === 1);
    expect(rows("SELECT count(*) AS n FROM content_refs")[0]!.n).toBe(0);
    tap.event({ type: "message.updated", botId: BOT, message: message("done") } as never);
    await waitFor(() => rows("SELECT count(*) AS n FROM entries WHERE stream = ? AND kind = 'message.updated'", STREAM)[0]!.n === 1);
    const updated = rows("SELECT seq FROM entries WHERE stream = ? AND kind = 'message.updated'", STREAM)[0]!;
    expect(rows("SELECT seq FROM content_names WHERE stream = ? AND line = 'm7'", STREAM).map((row) => Number(row.seq))).toEqual([Number(updated.seq)]);
    await waitFor(() => rows("SELECT count(*) AS n FROM entries WHERE stream = ? AND kind = 'content.ready'", STREAM)[0]!.n === 1);
    await service.idle();
    expect(rows("SELECT id FROM content_names WHERE line = 'm7'")[0]!.id).toBe(sha(data));
    const found = service.find({ t: "content.find", req: "f", botId: BOT, line: "m7", url: pathToFileURL(video).href });
    expect(found.ref?.state).toBe("ready");
    expect((await service.open({ t: "content.open", req: "o", owner: service.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry })).t).toBe("content.file");
  });

  it("a later update naming the same version references the same id; a rewritten file gets a new one", async () => {
    const picture = join(media, "plot.png");
    writeFileSync(picture, bytes("one", 9000));
    const l = line("m1", `![p](${picture})`);
    const first = await postLine(l);
    await first.ready;
    const again = await postLine(l); // e.g. a reaction updated the line
    expect(await again.ready).toEqual([]);
    expect(rows("SELECT id, seq FROM content_refs WHERE seq IN (?, ?) ORDER BY seq", first.entry.seq, again.entry.seq).map((row) => row.id)).toEqual([sha(bytes("one", 9000)), sha(bytes("one", 9000))]);
    writeFileSync(picture, bytes("two", 9001));
    const third = await postLine(l);
    await third.ready;
    expect(rows("SELECT id FROM content_names WHERE line = 'm1'").map((row) => row.id)).toEqual([sha(bytes("two", 9001))]);
    // The first entry still proves its own version.
    const opened = await service.open({ t: "content.open", req: "o", owner: service.serverId, id: sha(bytes("one", 9000)), variant: "original", entry: { stream: STREAM, seq: first.entry.seq } });
    expect(opened.t).toBe("content.file");
    if (opened.t === "content.file") expect(readFileSync(opened.path).equals(bytes("one", 9000))).toBe(true);
  });

  it("a file rewritten between the line's commit and its pin is `changed`, never pinned", async () => {
    const video = join(media, "fast.mp4");
    writeFileSync(video, bytes("before", 300_000));
    const l = line("m1", `![v](${video})`);
    const noted = await store.submit((db) => {
      const [entry] = appendEntries(db, STREAM, [{ kind: "message.added", body: messageBody(l) }], { now: Date.now() });
      return service.noteLine(db, BOT, l, entry!);
    });
    writeFileSync(video, bytes("after", 300_000));
    expect(await service.afterCommit(noted!)).toEqual([]);
    expect(rows("SELECT state, pin FROM content").map((row) => [row.state, row.pin])).toEqual([["changed", "path"]]);
    expect(existsSync(service.pinsDir) ? readdirSync(service.pinsDir) : []).toEqual([]);
    const found = service.find({ t: "content.find", req: "f", botId: BOT, line: "m1", url: `file://${video}` });
    const opened = await service.open({ t: "content.open", req: "o", owner: service.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
    expect(opened).toMatchObject({ t: "content.gone", reason: "changed" });
  });
});
