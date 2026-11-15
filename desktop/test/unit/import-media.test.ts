// M6-05: attachments in the 2.x import. Fixture folders only (temp copies from make2xFolder); no real 2.x data.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_BOT_ID, MAINTAINER_ID, toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { ContentService, isProtectedPath } from "../../src/server/content";
import { read2x } from "../../src/server/import";
import { importChats } from "../../src/server/import/chats";
import { mapIds } from "../../src/server/import/id-map";
import { copyMedia, mediaReport, planMedia, remapAttachments } from "../../src/server/import/media";
import { readEntries } from "../../src/server/log";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { make2xFolder } from "../support/fixture-2x";

const TARGET_MAIN_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const TARGET_MAINTAINER_ID = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const BASE = toSwiftDate(Date.UTC(2026, 0, 2, 12, 0, 0));

const dirs: string[] = [];
const stores: ServerStore[] = [];
const services: ContentService[] = [];

function tempDir(prefix = "botling-import-media-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setModeRecursive(dir: string, dirMode: number, fileMode: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // chmod would follow it
    if (entry.isDirectory()) {
      setModeRecursive(full, dirMode, fileMode);
      chmodSync(full, dirMode);
    } else {
      chmodSync(full, fileMode);
    }
  }
  chmodSync(dir, dirMode);
}

afterEach(async () => {
  for (const svc of services.splice(0)) await svc.close();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) {
    try {
      setModeRecursive(dir, 0o755, 0o644);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Snapshot {
  rel: string;
  kind: "file" | "dir" | "link";
  size: number;
  mtimeMs: number;
  sha256: string;
}

function snapshot(root: string, dir = root, out: Snapshot[] = []): Snapshot[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const stat = lstatSync(full);
    if (entry.isSymbolicLink()) {
      out.push({ rel: relative(root, full), kind: "link", size: stat.size, mtimeMs: stat.mtimeMs, sha256: "" });
    } else if (entry.isDirectory()) {
      out.push({ rel: relative(root, full), kind: "dir", size: 0, mtimeMs: stat.mtimeMs, sha256: "" });
      snapshot(root, full, out);
    } else {
      out.push({
        rel: relative(root, full),
        kind: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
      });
    }
  }
  return out;
}

function png(tag: string, size = 2_000): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(size - head.length, tag)]);
}

function userLine(n: number, text: string, urls: string[]): ChatRecord {
  return {
    id: `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`,
    role: "user",
    text,
    date: BASE + n,
    attachments: urls.map((url) => ({ url, kind: "image" })),
  };
}

function fileUrl(path: string): string {
  return pathToFileURL(path).toString();
}

interface Run {
  src: string;
  dataDir: string;
  store: ServerStore;
  content: ContentService;
  plan: ReturnType<typeof planMedia>;
  copied: ReturnType<typeof copyMedia>;
  result: Awaited<ReturnType<typeof importChats>>;
  newMainId: string;
}

async function openStack(dataDir = tempDir("botling-import-media-db-")): Promise<{ dataDir: string; store: ServerStore; content: ContentService }> {
  const store = await openServerStore(dataDir);
  stores.push(store);
  const content = new ContentService({ store, dataDir, serverId: store.meta("serverId")! });
  services.push(content);
  return { dataDir, store, content };
}

function sourceHashOf(src: string): string {
  return createHash("sha256").update(realpathSync.native(src)).digest("hex");
}

async function runImport(
  src: string,
  options: { limit?: number; stack?: Awaited<ReturnType<typeof openStack>>; onBatch?: (info: { oldId: string; batch: number }) => void; batchSize?: number } = {},
): Promise<Run> {
  const stack = options.stack ?? (await openStack());
  const data = read2x(src);
  const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
  const plan = planMedia(data.bots, idMap, src, options.limit);
  const copied = copyMedia(plan, stack.dataDir, sourceHashOf(src));
  const result = await importChats(stack.store, data.bots, idMap, {
    source: sourceHashOf(src),
    content: stack.content,
    attachmentMap: copied.map,
    ...(options.batchSize ? { batchSize: options.batchSize } : {}),
    ...(options.onBatch ? { onBatch: options.onBatch } : {}),
  });
  return { src, ...stack, plan, copied, result, newMainId: TARGET_MAIN_ID };
}

function mainEntries(run: Run): Array<{ seq: number; kind: string; body: any }> {
  const reader = run.store.openReader();
  try {
    return readEntries(reader, `bot:${run.newMainId}`, 1, { maxEntries: 1000, maxBytes: 50_000_000 }).entries.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      body: e.body,
    }));
  } finally {
    reader.close();
  }
}

function addedMessage(run: Run, msgId: string): any {
  const found = mainEntries(run).find((e) => e.kind === "message.added" && e.body.message.id === msgId);
  expect(found).toBeTruthy();
  return found!.body.message;
}

function rows(store: ServerStore, sql: string, ...args: Array<string | number>): Array<Record<string, unknown>> {
  const reader = store.openReader();
  try {
    return reader.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  } finally {
    reader.close();
  }
}

/** A fixture 2.x folder whose main bot has the given extra lines. */
function makeSource(extra: (dir: string) => ChatRecord[]): string {
  const src = join(tempDir(), "v2");
  mkdirSync(src, { recursive: true });
  make2xFolder(src, { extraMainMessages: extra(src) });
  return src;
}

describe("M6-05 attachments in the 2.x import", () => {
  it("1. an image inside the 2.x folder is copied under <dataDir>/imported/, served by content, and still opens after the folder moves", async () => {
    const pic = png("a");
    let msg!: ChatRecord;
    const src = makeSource((dir) => {
      msg = userLine(1, "Look at this", [fileUrl(join(dir, "attachments", "pic.png"))]);
      return [msg];
    });
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), pic);

    const run = await runImport(src);
    const view = addedMessage(run, msg.id);
    const url = view.attachments[0].url as string;
    const importedRoot = fileUrl(join(run.dataDir, "imported", sourceHashOf(src)));
    expect(url.startsWith(`${importedRoot}/`)).toBe(true);
    // The fixture's own note.txt is the main bot's first inside file, so the picture is the second.
    expect(url).toMatch(new RegExp(`/${TARGET_MAIN_ID}/2-pic\\.png$`));
    // The display name is the file's own name, not the copy's `<n>-` prefix.
    expect(view.attachments[0].name).toBe("pic.png");
    expect(run.plan.entries.filter((e) => e.state === "inside")).toHaveLength(2); // note.txt and pic.png
    expect(run.copied.failed).toEqual([]);

    // Move the 2.x folder away: the copy, the line's URL and the content reference all still work.
    renameSync(src, `${src}-moved`);
    const found = run.content.find({ t: "content.find", req: "f", botId: TARGET_MAIN_ID, line: msg.id, url });
    expect(found.ref).not.toBeNull();
    expect(found.ref!.id.startsWith("sha256:")).toBe(true);
    const opened = await run.content.open({ t: "content.open", req: "o", owner: run.content.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
    expect(opened.t).toBe("content.file");
    if (opened.t === "content.file") expect(readFileSync(opened.path).equals(pic)).toBe(true);
    expect(existsSync(fileURLToPath(url))).toBe(true);
    // Nothing the line points at is in the 2.x folder any more.
    for (const e of mainEntries(run)) {
      if (e.kind === "message.added") for (const a of e.body.message.attachments ?? []) expect(String(a.url)).not.toContain(`${src}`);
    }
  });

  it("2. a file outside the 2.x folder keeps its URL and opens in place", async () => {
    const outsideDir = tempDir("botling-import-media-out-");
    const pic = png("o");
    const outside = join(outsideDir, "elsewhere.png");
    writeFileSync(outside, pic);
    let msg!: ChatRecord;
    const src = makeSource(() => {
      msg = userLine(2, "From elsewhere", [fileUrl(outside)]);
      return [msg];
    });

    const run = await runImport(src);
    const view = addedMessage(run, msg.id);
    expect(view.attachments[0].url).toBe(fileUrl(outside));
    expect(run.plan.entries.find((e) => e.url === fileUrl(outside))?.state).toBe("outside");
    // Only the fixture's own note.txt (inside) was copied; the outside picture was not.
    expect(readdirSync(join(run.dataDir, "imported", sourceHashOf(src), TARGET_MAIN_ID))).toEqual(["1-note.txt"]);

    const found = run.content.find({ t: "content.find", req: "f", botId: TARGET_MAIN_ID, line: msg.id, url: fileUrl(outside) });
    expect(found.ref).not.toBeNull();
    const opened = await run.content.open({ t: "content.open", req: "o", owner: run.content.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
    expect(opened.t).toBe("content.file");
    if (opened.t === "content.file") expect(readFileSync(opened.path).equals(pic)).toBe(true);
  });

  it("3. the import limit: two 800 KiB images with a 1 MiB limit copy the first and list the second as over", async () => {
    const a = png("a", 800 * 1024);
    const b = png("b", 800 * 1024);
    let first!: ChatRecord;
    let second!: ChatRecord;
    const src = makeSource((dir) => {
      first = userLine(3, "one", [fileUrl(join(dir, "attachments", "a.png"))]);
      second = userLine(4, "two", [fileUrl(join(dir, "attachments", "b.png"))]);
      return [first, second];
    });
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "a.png"), a);
    writeFileSync(join(src, "attachments", "b.png"), b);

    const run = await runImport(src, { limit: 1024 * 1024 });
    const states = run.plan.entries.filter((e) => e.url.includes("/attachments/")).map((e) => [e.url.split("/").pop(), e.state]);
    expect(states).toEqual([["a.png", "inside"], ["b.png", "over"]]);
    expect(addedMessage(run, first.id).attachments[0].url).toContain("/imported/");
    expect(addedMessage(run, second.id).attachments[0].url).toBe(fileUrl(join(src, "attachments", "b.png")));
    expect(run.plan.over.count).toBe(1);
    expect(run.plan.over.bytes).toBe(b.length);

    const report = mediaReport(run.plan, run.copied, { home: "/nonexistent-home" });
    // (the fixture's note.txt is copied too)
    expect(report[0]).toBe("Copied 2 attachments (800 KB) into Botling 3's folder.");
    expect(report[1]).toBe("Not copied (over the 1 MB import limit): 1 file (800 KB); they open from the Botling 2 folder while it is there.");
  });

  it("4. a missing file is listed and the line is still imported", async () => {
    let msg!: ChatRecord;
    const src = makeSource((dir) => {
      msg = userLine(5, "Gone", [fileUrl(join(dir, "attachments", "gone.png"))]);
      return [msg];
    });
    const run = await runImport(src);
    const view = addedMessage(run, msg.id);
    expect(view.attachments[0].url).toBe(fileUrl(join(src, "attachments", "gone.png")));
    expect(view.attachments[0].missing).toBe(true);
    expect(run.plan.entries.find((e) => e.url.endsWith("/gone.png"))?.state).toBe("missing");
    expect(run.result.bots.find((b) => b.oldId === MAIN_BOT_ID)?.lines).toBe(4);

    const home = tempDir("botling-import-media-home-");
    const homeSrc = join(home, "Pictures", "lost.png");
    const report = mediaReport(
      { ...run.plan, entries: [{ ...run.plan.entries.find((e) => e.state === "missing")!, path: homeSrc }] },
      run.copied,
      { home },
    );
    expect(report).toContain("Missing in Botling 2 already: 1 file (listed below).");
    expect(report).toContain("  ~/Pictures/lost.png");
  });

  it("5. the 2.x folder is unchanged by the import, mtimes of the copied files included, and the copy is separate from it", async () => {
    const pic = png("s");
    let msg!: ChatRecord;
    const src = makeSource((dir) => {
      msg = userLine(6, "Keep", [fileUrl(join(dir, "attachments", "s.png"))]);
      return [msg];
    });
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "s.png"), pic);
    setModeRecursive(src, 0o555, 0o444); // a write into the source would fail loudly
    const before = snapshot(src);
    const run = await runImport(src);
    expect(snapshot(src)).toEqual(before);
    // The copy is its own file: not a link to the source, not inside it.
    const copy = readdirSync(join(run.dataDir, "imported", sourceHashOf(src), TARGET_MAIN_ID))[0]!;
    const copyPath = join(run.dataDir, "imported", sourceHashOf(src), TARGET_MAIN_ID, copy);
    expect(lstatSync(copyPath).isSymbolicLink()).toBe(false);
    expect(statSync(copyPath).ino).not.toBe(statSync(join(src, "attachments", "s.png")).ino);
    expect(readdirSync(join(run.dataDir, "imported", sourceHashOf(src), TARGET_MAIN_ID)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("6. classification follows real paths; secrets files and non-file URLs are never copied; one URL is copied once", async () => {
    const outsideDir = tempDir("botling-import-media-out-");
    const outsidePic = join(outsideDir, "o.png");
    writeFileSync(outsidePic, png("o"));
    const insidePic = png("i");
    let lines: ChatRecord[] = [];
    const src = makeSource((dir) => {
      lines = [
        // A link inside the folder that leaves it: its real path is outside -> referenced in place.
        userLine(7, "out-link", [fileUrl(join(dir, "attachments", "to-outside.png"))]),
        // A link outside that enters the folder: its real path is inside -> copied.
        userLine(8, "in-link", [fileUrl(join(outsideDir, "to-inside.png"))]),
        // The sealed secrets file and a web URL.
        userLine(9, "secrets", [fileUrl(join(dir, "plugin-secrets.json")), "https://example.com/x.png"]),
        // The same inside file twice.
        userLine(10, "twice", [fileUrl(join(dir, "attachments", "i.png")), fileUrl(join(dir, "attachments", "i.png"))]),
      ];
      return lines;
    });
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "i.png"), insidePic);
    symlinkSync(outsidePic, join(src, "attachments", "to-outside.png"));
    symlinkSync(join(src, "attachments", "i.png"), join(outsideDir, "to-inside.png"));

    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    const stateOf = (suffix: string) => plan.entries.filter((e) => e.url.endsWith(suffix)).map((e) => e.state);
    expect(stateOf("/to-outside.png")).toEqual(["outside"]);
    expect(stateOf("/to-inside.png")).toEqual(["inside"]);
    expect(stateOf("/plugin-secrets.json")).toEqual(["secret"]);
    expect(plan.entries.some((e) => e.url.startsWith("https:"))).toBe(false);
    expect(stateOf("/i.png").filter((s) => s === "inside")).toHaveLength(1);

    const dataDir = tempDir("botling-import-media-db-");
    const copied = copyMedia(plan, dataDir, sourceHashOf(src));
    const all = [...copied.map.keys()];
    expect(all.some((u) => u.endsWith("/plugin-secrets.json"))).toBe(false);
    expect(readdirSync(join(dataDir, "imported", sourceHashOf(src), TARGET_MAIN_ID)).sort()).toHaveLength(3); // note.txt, i.png, and the link that enters the folder (its real file)
    // No copy of the secrets file anywhere under the target.
    const names: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { names.push(e.name); if (e.isDirectory()) walk(join(d, e.name)); } };
    walk(dataDir);
    expect(names.some((n) => n.includes("plugin-secrets"))).toBe(false);
  });

  it("7. a target folder that is, or reaches through a link into, the 2.x folder is refused and nothing is written there", () => {
    const src = makeSource(() => [userLine(11, "x", [])]);
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "p.png"), png("p"));
    const lines = [userLine(12, "p", [fileUrl(join(src, "attachments", "p.png"))])];
    writeFileSync(join(src, "main", "chat.json"), JSON.stringify(lines));
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    expect(plan.entries.filter((e) => e.state === "inside")).toHaveLength(1);
    const before = snapshot(src);

    // 1. the 2.x folder itself, 2. a folder inside it, 3. a link to it, 4. a not-yet-existing folder under that link,
    // 5. the 2.x folder given through a link and the target through its real path.
    const holder = tempDir();
    symlinkSync(src, join(holder, "alias"));
    const targets = [src, join(src, "v3"), join(holder, "alias"), join(holder, "alias", "v3", "deeper")];
    for (const target of targets) {
      expect(() => copyMedia(plan, target, sourceHashOf(src))).toThrow(/separate folders/);
    }
    const linkedPlan = planMedia(data.bots, idMap, join(holder, "alias"));
    expect(() => copyMedia(linkedPlan, join(src, "v3"), sourceHashOf(src))).toThrow(/separate folders/);
    expect(snapshot(src)).toEqual(before);
  });

  it("8. remapAttachments changes only the attachment URLs of a copy", () => {
    const record: ChatRecord = {
      id: "r1",
      role: "user",
      text: "see file:///elsewhere/a.png",
      date: 1,
      attachments: [
        { url: "file:///x/a.png", kind: "image" },
        { url: "file:///x/b.png", kind: "file" },
      ],
      replyTo: "r0",
    };
    const copy = remapAttachments(record, new Map([["file:///x/a.png", "file:///data/imported/1-a.png"]]));
    expect(copy).not.toBe(record);
    expect(copy.attachments).toEqual([
      { url: "file:///data/imported/1-a.png", kind: "image" },
      { url: "file:///x/b.png", kind: "file" },
    ]);
    expect({ ...copy, attachments: undefined }).toEqual({ ...record, attachments: undefined });
    expect(record.attachments![0]!.url).toBe("file:///x/a.png"); // the input is not mutated
    const plain: ChatRecord = { id: "r2", role: "bot", text: "hi", date: 2 };
    expect(remapAttachments(plain, new Map([["a", "b"]]))).toEqual(plain);
  });

  it("9. the report lines are exact", () => {
    const home = "/home-fixture";
    const plan = {
      sourceReal: "/src",
      limit: 2 * 2 ** 30,
      entries: [
        { botNewId: "b", url: "file:///src/a.png", path: "/src/a.png", real: "/src/a.png", size: 1.2 * 2 ** 30, state: "inside" as const },
        { botNewId: "b", url: "file:///home-fixture/gone/1.png", path: "/home-fixture/gone/1.png", real: null, size: 0, state: "missing" as const },
        { botNewId: "b", url: "file:///elsewhere/2.png", path: "/elsewhere/2.png", real: null, size: 0, state: "missing" as const },
        { botNewId: "b", url: "file:///src/big.mov", path: "/src/big.mov", real: "/src/big.mov", size: 4.1 * 2 ** 30, state: "over" as const },
      ],
      over: { count: 1, bytes: 4.1 * 2 ** 30 },
    };
    const lines = mediaReport(plan, { map: new Map([["file:///src/a.png", "file:///d/1-a.png"]]), failed: [], bytes: 1.2 * 2 ** 30, count: 1 }, { home });
    expect(lines).toEqual([
      "Copied 1 attachment (1.2 GB) into Botling 3's folder.",
      "Not copied (over the 2 GB import limit): 1 file (4.1 GB); they open from the Botling 2 folder while it is there.",
      "Missing in Botling 2 already: 2 files (listed below).",
      "  ~/gone/1.png",
      "  /elsewhere/2.png",
    ]);
    expect(mediaReport({ ...plan, entries: [], over: { count: 0, bytes: 0 } }, { map: new Map(), failed: [], bytes: 0, count: 0 }, { home })).toEqual([]);
  });

  it("10. a crash part-way and a second run: no doubled lines, no stale content rows, the attachment still opens", async () => {
    const pic = png("r");
    let msg!: ChatRecord;
    const src = makeSource((dir) => {
      msg = userLine(13, "pic", [fileUrl(join(dir, "attachments", "r.png"))]);
      return [msg, userLine(14, "after the picture", [])];
    });
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "r.png"), pic);

    const stack = await openStack();
    await expect(
      runImport(src, {
        stack,
        batchSize: 1,
        onBatch: (info) => {
          // Main's 4th line is the picture (noted in batch 4's transaction); crash before the 5th line.
          if (info.oldId === MAIN_BOT_ID && info.batch === 5) throw new Error("crash after the picture was noted");
        },
      }),
    ).rejects.toThrow(/crash/);
    expect(rows(stack.store, "SELECT 1 FROM content_names").length).toBeGreaterThan(0);

    const run = await runImport(src, { stack, batchSize: 1 });
    const added = mainEntries(run).filter((e) => e.kind === "message.added");
    expect(added.map((e) => e.body.message.id).sort()).toEqual([...new Set(added.map((e) => e.body.message.id))].sort());
    expect(added).toHaveLength(5);
    expect(rows(stack.store, "SELECT id FROM content WHERE state = 'preparing'")).toEqual([]);
    expect(rows(stack.store, "SELECT id FROM content")).toHaveLength(1);
    expect(rows(stack.store, "SELECT path FROM content_names")).toHaveLength(1);
    const found = run.content.find({ t: "content.find", req: "f", botId: TARGET_MAIN_ID, line: msg.id, url: addedMessage(run, msg.id).attachments[0].url });
    expect(found.ref?.id.startsWith("sha256:")).toBe(true);
  });

  it("11. <dataDir>/imported/ is the one part of botlingd's own folder that content may index", () => {
    const dataDir = "/data-fixture";
    expect(isProtectedPath(`${dataDir}/server.db`, { dataDir })).toBe(true);
    expect(isProtectedPath(`${dataDir}/pins/x`, { dataDir })).toBe(true);
    expect(isProtectedPath(`${dataDir}/imported/${"a".repeat(64)}/b/1-x.png`, { dataDir })).toBe(false);
    expect(isProtectedPath(`${dataDir}/imported/../server.db`, { dataDir })).toBe(true);
    expect(isProtectedPath(`${dataDir}/imported`, { dataDir })).toBe(true);
  });
});

describe("the maintainer line is untouched", () => {
  it("imports a source without attachments exactly as before (no imported/ folder, no content rows)", async () => {
    const src = join(tempDir(), "v2");
    make2xFolder(src, {});
    // The fixture's note.txt attachment is inside the 2.x folder: copied, though content does not index a .txt.
    const run = await runImport(src);
    expect(run.plan.entries.filter((e) => e.state === "inside")).toHaveLength(1);
    expect(rows(run.store, "SELECT 1 FROM content")).toEqual([]);
    expect(run.result.bots.find((b) => b.oldId === MAINTAINER_ID)?.lines).toBe(1);
  });
});

function caseInsensitive(dir: string): boolean {
  const probe = join(dir, "CaseProbe");
  mkdirSync(probe);
  try { return existsSync(join(dir, "caseprobe")); } finally { rmSync(probe, { recursive: true }); }
}

describe("M6-05 review: real paths, the planned file only, the protected list", () => {
  it("12. target inside the source by a case-different spelling is refused", () => {
    const root = tempDir();
    if (!caseInsensitive(root)) return;
    const src = join(root, "V2");
    mkdirSync(src);
    make2xFolder(src, { extraMainMessages: [] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    let threw = false;
    try { copyMedia(plan, join(root, "v2", "v3"), "h"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(existsSync(join(src, "v3"))).toBe(false);
  });

  it("13. an attachment URL spelled in another case than the source is still inside", () => {
    const root = tempDir();
    if (!caseInsensitive(root)) return;
    const src = join(root, "V2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [fileUrl(join(root, "v2", "attachments", "pic.png"))])] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    const e = plan.entries.find((x) => x.url.endsWith("pic.png"))!;
    expect(e.state).toBe("inside");
  });

  it("14. a file swapped for a link after planning is not copied (TOCTOU)", () => {
    const root = tempDir();
    const src = join(root, "v2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [fileUrl(join(src, "attachments", "pic.png"))])] });
    const outside = join(tempDir("botling-out-"), "private.png");
    writeFileSync(outside, png("S"));
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    unlinkSync(join(src, "attachments", "pic.png"));
    symlinkSync(outside, join(src, "attachments", "pic.png"));
    const dataDir = tempDir("botling-db-");
    const copied = copyMedia(plan, dataDir, "h");
    const url = [...copied.map.entries()].find(([k]) => k.endsWith("pic.png"))?.[1];
    const leaked = url ? readFileSync(fileURLToPath(url)).equals(png("S")) : false;
    expect(leaked).toBe(false);
    expect(copied.failed.map((f) => f.path)).toEqual([join(src, "attachments", "pic.png")]);

    // The same with the folder above swapped for a link (the last part is a plain file there): the inode check holds.
    unlinkSync(join(src, "attachments", "pic.png"));
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    const plan3 = planMedia(data.bots, idMap, src);
    const elsewhere = tempDir("botling-out2-");
    writeFileSync(join(elsewhere, "pic.png"), png("S"));
    renameSync(join(src, "attachments"), join(src, "attachments-old"));
    symlinkSync(elsewhere, join(src, "attachments"));
    const copied3 = copyMedia(plan3, tempDir("botling-db-"), "h");
    const url3 = [...copied3.map.entries()].find(([k]) => k.endsWith("pic.png"))?.[1];
    expect(url3 ? readFileSync(fileURLToPath(url3)).equals(png("S")) : false).toBe(false);
    expect(copied3.failed).toHaveLength(1);
  });

  it("15. a file that grew after planning is not read past its planned size", () => {
    const root = tempDir();
    const src = join(root, "v2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [fileUrl(join(src, "attachments", "pic.png"))])] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    appendFileSync(join(src, "attachments", "pic.png"), Buffer.alloc(5_000_000, 1));
    const dataDir = tempDir("botling-db-");
    const copied = copyMedia(plan, dataDir, "h");
    expect(copied.failed.length).toBe(1);
  });

  it("16. an existing <dataDir>/imported link into the source is refused", () => {
    const root = tempDir();
    const src = join(root, "v2");
    make2xFolder(src, { extraMainMessages: [] });
    const dataDir = tempDir("botling-db-");
    symlinkSync(src, join(dataDir, "imported"));
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    expect(() => copyMedia(plan, dataDir, "h")).toThrow("The import's source and target must be separate folders.");
    expect(existsSync(join(src, "h"))).toBe(false);
  });

  it("17. a link under <dataDir>/imported/ to server.db is not indexed; and elsewhere", async () => {
    const stack = await openStack();
    const dbFile = join(stack.dataDir, "server.db");
    mkdirSync(join(stack.dataDir, "imported", "h", "b"), { recursive: true });
    symlinkSync(dbFile, join(stack.dataDir, "imported", "h", "b", "x.png"));
    const elsewhere = tempDir("botling-else-");
    symlinkSync(dbFile, join(elsewhere, "y.png"));
    const noted = await stack.store.submit((db) => {
      const a = stack.content.noteLine(db, TARGET_MAIN_ID, { id: "l1", attachments: [{ url: fileUrl(join(stack.dataDir, "imported", "h", "b", "x.png")) }] }, { stream: `bot:${TARGET_MAIN_ID}` as any, seq: 1 });
      const b = stack.content.noteLine(db, TARGET_MAIN_ID, { id: "l2", attachments: [{ url: fileUrl(join(elsewhere, "y.png")) }] }, { stream: `bot:${TARGET_MAIN_ID}` as any, seq: 2 });
      return { a: a?.files.length ?? 0, b: b?.files.length ?? 0 };
    });
    expect(noted).toEqual({ a: 0, b: 0 });
  });

  it("18. report paths with control characters are escaped", () => {
    const plan = { sourceReal: "/s", limit: 10, over: { count: 0, bytes: 0 }, entries: [{ botNewId: "b", url: "file:///x", path: "/x/a\u001b[31mred\nInjected line.png", real: null, size: 0, state: "missing" as const }] };
    const lines = mediaReport(plan, { map: new Map(), failed: [], count: 0, bytes: 0 }, { home: "/nohome" });
    // eslint-disable-next-line no-control-regex
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(lines.length).toBe(2);
  });

  it("19. a second run keeps the copy the first run made (same inode), so a path pin on it stays valid", () => {
    const root = tempDir();
    const src = join(root, "v2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [fileUrl(join(src, "attachments", "pic.png"))])] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const dataDir = tempDir("botling-db-");
    const first = copyMedia(planMedia(data.bots, idMap, src), dataDir, "h");
    const url = [...first.map.entries()].find(([k]) => k.endsWith("pic.png"))![1];
    const ino = statSync(fileURLToPath(url)).ino;
    const second = copyMedia(planMedia(data.bots, idMap, src), dataDir, "h");
    expect(second.map.get([...first.map.keys()].find((k) => k.endsWith("pic.png"))!)).toBe(url);
    expect(statSync(fileURLToPath(url)).ino).toBe(ino);
    expect(second.failed).toEqual([]);
  });

  it("20. a 255-byte file name and odd names copy safely", () => {
    const root = tempDir();
    const src = join(root, "v2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    const long = "é".repeat(125) + "ab.png"; // 256 bytes? keep <=255
    const name = Buffer.byteLength(long) > 255 ? "é".repeat(124) + "abc.png" : long;
    writeFileSync(join(src, "attachments", name), png("l"));
    writeFileSync(join(src, "attachments", "..png"), png("d"));
    writeFileSync(join(src, "attachments", "a\\b\u0001.png"), png("c"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [name, "..png", "a\\b\u0001.png"].map((n) => fileUrl(join(src, "attachments", n))))] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const plan = planMedia(data.bots, idMap, src);
    const dataDir = tempDir("botling-db-");
    const copied = copyMedia(plan, dataDir, "h");
    expect(copied.failed).toEqual([]);
    for (const v of copied.map.values()) expect(fileURLToPath(v).startsWith(join(realpathSync(dataDir), "imported") ) || fileURLToPath(v).startsWith(join(dataDir, "imported"))).toBe(true);
  });
  it("21. a bot folder under imported/<hash>/ that is a link is not written through", () => {
    const root = tempDir();
    const src = join(root, "v2");
    mkdirSync(join(src, "attachments"), { recursive: true });
    writeFileSync(join(src, "attachments", "pic.png"), png("p"));
    make2xFolder(src, { extraMainMessages: [userLine(1, "x", [fileUrl(join(src, "attachments", "pic.png"))])] });
    const data = read2x(src);
    const idMap = mapIds(data.bots, { mainId: TARGET_MAIN_ID, maintainerId: TARGET_MAINTAINER_ID, designated: true });
    const dataDir = tempDir("botling-db-");
    const elsewhere = tempDir("botling-elsewhere-");
    mkdirSync(join(dataDir, "imported", "h"), { recursive: true });
    symlinkSync(elsewhere, join(dataDir, "imported", "h", TARGET_MAIN_ID));
    const copied = copyMedia(planMedia(data.bots, idMap, src), dataDir, "h");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(copied.count).toBe(0);
    expect(copied.failed.length).toBeGreaterThan(0);
  });
});
