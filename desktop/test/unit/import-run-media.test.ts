// M6-05 wiring: `runImport` (server/import/run.ts, M6-01d) must run the media step itself. Fixture folders only (temp
// copies from make2xFolder); no real 2.x data. The media step's own rules (real paths, planned file only, protected
// links, imported/ links) are tested in import-media.test.ts; this file proves run.ts invokes them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { toSwiftDate, type ChatRecord } from "../../src/core/store/records";
import { ContentService } from "../../src/server/content";
import { runImport } from "../../src/server/import/run";
import { readEntries } from "../../src/server/log";
import { openServerStore } from "../../src/server/store";
import { make2xFolder } from "../support/fixture-2x";

const dirs: string[] = [];

function tempRoot(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "botling-import-run-media-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function png(tag: string, size = 2_000): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(size - head.length, tag)]);
}

function fileUrl(path: string): string {
  return pathToFileURL(path).toString();
}

function line(n: number, text: string, urls: string[]): ChatRecord {
  return {
    id: `00000000-0000-4000-8000-${String(2000 + n).padStart(12, "0")}`,
    role: "user",
    text,
    date: toSwiftDate(Date.UTC(2026, 1, 1, 12, 0, n)),
    attachments: urls.map((url) => ({ url, kind: "image" })),
  };
}

function snapshot(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(root, full, out);
    else if (entry.isFile()) {
      out.push(`${relative(root, full)} ${statSync(full).size} ${statSync(full).mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  }
  return out;
}

const sourceHashOf = (src: string): string => createHash("sha256").update(realpathSync.native(src)).digest("hex");

interface Fixture {
  root: string;
  src: string;
  dataDir: string;
  outsideUrl: string;
  lineInside: ChatRecord;
  lineOutside: ChatRecord;
  pic: Buffer;
  outsidePic: Buffer;
}

function makeFixture(): Fixture {
  const root = tempRoot();
  const src = join(root, "v2");
  const dataDir = join(root, "v3");
  const outsideDir = join(root, "elsewhere");
  mkdirSync(outsideDir, { recursive: true });
  const outsidePath = join(outsideDir, "outside.png");
  const outsidePic = png("o");
  writeFileSync(outsidePath, outsidePic);
  const pic = png("i");
  const lineInside = line(1, "A picture inside the 2.x folder", [fileUrl(join(src, "attachments", "pic.png"))]);
  const lineOutside = line(2, "A picture outside the 2.x folder", [fileUrl(outsidePath)]);
  make2xFolder(src, { extraMainMessages: [lineInside, lineOutside] });
  mkdirSync(join(src, "attachments"), { recursive: true });
  writeFileSync(join(src, "attachments", "pic.png"), pic);
  return { root, src, dataDir, outsideUrl: fileUrl(outsidePath), lineInside, lineOutside, pic, outsidePic };
}

describe("M6-05 media step wired into run.ts (M6-01d)", () => {
  it("1. runImport copies the 2.x folder's attachments, remaps their lines, indexes them, and leaves the source alone", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.src);

    const result = await runImport({ sourceDir: fx.src, targetDir: fx.dataDir });
    expect(result.dryRun).toBe(false);
    expect(snapshot(fx.src)).toEqual(before);

    const main = result.bots.find((b) => b.kind === "main")!;
    const hash = sourceHashOf(fx.src);
    expect(result.sourceHash).toBe(hash);
    const copyDir = join(fx.dataDir, "imported", hash, main.newId);
    // note.txt (the fixture's own attachment) and pic.png are inside the 2.x folder; the outside picture is not copied.
    expect(readdirSync(copyDir).sort()).toEqual(["1-note.txt", "2-pic.png"]);
    expect(readFileSync(join(copyDir, "2-pic.png")).equals(fx.pic)).toBe(true);

    // The report's Media section says what was copied (not "not imported yet"), in the printed text and the file.
    expect(result.reportText).toContain("Copied 2 attachments");
    expect(result.reportText).not.toContain("not imported yet (M6-05)");
    expect(readFileSync(result.reportPath, "utf8")).toBe(result.reportText);

    // Move the 2.x folder away: the lines, their copies and the content index no longer need it.
    renameSync(fx.src, `${fx.src}-moved`);
    const store = await openServerStore(fx.dataDir);
    const content = new ContentService({ store, dataDir: fx.dataDir, serverId: store.meta("serverId")! });
    try {
      const reader = store.openReader();
      let added: Array<{ id: string; attachments: Array<{ url: string }> }> = [];
      try {
        added = readEntries(reader, `bot:${main.newId}`, 1, { maxEntries: 1000, maxBytes: 50_000_000 })
          .entries.filter((e) => e.kind === "message.added")
          .map((e) => (e.body as { message: { id: string; attachments: Array<{ url: string }> } }).message);
      } finally {
        reader.close();
      }
      const inside = added.find((m) => m.id === fx.lineInside.id)!;
      const outside = added.find((m) => m.id === fx.lineOutside.id)!;
      const insideUrl = inside.attachments[0]!.url;
      expect(insideUrl).toBe(fileUrl(join(copyDir, "2-pic.png")));
      expect(insideUrl).not.toContain(fx.src);
      expect(outside.attachments[0]!.url).toBe(fx.outsideUrl);

      // `noteLine` ran in the line's transaction: both pictures have a content reference and open.
      for (const [msg, url, bytes] of [
        [fx.lineInside, insideUrl, fx.pic],
        [fx.lineOutside, fx.outsideUrl, fx.outsidePic],
      ] as const) {
        const found = content.find({ t: "content.find", req: "f", botId: main.newId, line: msg.id, url });
        expect(found.ref, url).not.toBeNull();
        const opened = await content.open({ t: "content.open", req: "o", owner: content.serverId, id: found.ref!.id, variant: "original", entry: found.ref!.entry });
        expect(opened.t).toBe("content.file");
        if (opened.t === "content.file") expect(readFileSync(opened.path).equals(bytes)).toBe(true);
      }
      expect(existsSync(fileURLToPath(insideUrl))).toBe(true);
    } finally {
      await content.close();
      await store.close();
    }
  }, 90_000);

  it("2. --dry-run plans the media (names what a real run would copy) and copies nothing", async () => {
    const fx = makeFixture();
    const before = snapshot(fx.src);

    const result = await runImport({ sourceDir: fx.src, targetDir: fx.dataDir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.reportText).toContain("Would copy 2 attachments");
    expect(result.reportText).not.toContain("not imported yet (M6-05)");
    expect(existsSync(join(fx.dataDir, "imported"))).toBe(false);
    expect(existsSync(join(fx.dataDir, "server.db"))).toBe(false);
    expect(snapshot(fx.src)).toEqual(before);
  }, 90_000);
});
