// A picture or video a chat line shows by its local path (`![plot](file:///…/training.png)`), kept as it
// was when the line was posted. A bot often rewrites the same file (a plot redrawn each run) and names
// it again in its next reply: each line then shows its own picture, not the newest one, and never the
// copy the page loaded for an earlier line (the page reuses a picture it loaded by URL, so every line
// asks with its own URL: attachment-url.ts `attachmentURL`'s `line`).
//
// The copies live in the bot's store, `line-media/<line id>/<hash of the path><ext>`, made as the line
// is finished (`keepLineMedia`). A line without a copy (older history, a file too large) shows the file
// as it is now.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentKind } from "./attachments";

/** A larger file is shown as it is now, not copied (a long video would fill the disk line by line). */
export const LINE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function folder(storeDir: string, lineId: string): string {
  return join(storeDir, "line-media", lineId.replaceAll(":", "_"));
}

/** Where a line's copy of `path` is (whether or not it has been made). */
export function lineMediaFile(storeDir: string, lineId: string, path: string): string | null {
  if (!SAFE_ID.test(lineId)) return null;
  const name = createHash("sha256").update(path).digest("hex").slice(0, 32) + extname(path).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return join(folder(storeDir, lineId), name);
}

/** The line's copy of `path`, if it has one. */
export function lineMediaCopy(storeDir: string, lineId: string, path: string): string | null {
  const file = lineMediaFile(storeDir, lineId, path);
  return file && existsSync(file) ? file : null;
}

/** The local pictures and videos a line's text shows: file:// URLs, and absolute paths as a Markdown image or link target. */
export function localMediaPaths(text: string): string[] {
  const found = new Set<string>();
  for (const url of text.match(/file:\/\/[^\s)\]>"'<]+/g) ?? []) {
    try { found.add(fileURLToPath(url)); } catch { /* not a local file URL */ }
  }
  for (const match of text.matchAll(/\]\((\/[^\s)]+)\)/g)) {
    const path = match[1]!;
    if (path.startsWith("//")) continue;
    try { found.add(decodeURIComponent(path)); } catch { found.add(path); }
  }
  return [...found].filter((path) => attachmentKind(path) !== "file");
}

/** Copies each local picture or video the line shows into its own store, as the files are now. Never throws. */
export function keepLineMedia(storeDir: string, lineId: string, text: string): void {
  for (const path of localMediaPaths(text)) {
    const file = lineMediaFile(storeDir, lineId, path);
    if (!file || existsSync(file)) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > LINE_MEDIA_MAX_BYTES) continue;
      mkdirSync(folder(storeDir, lineId), { recursive: true });
      const partial = `${file}.${randomUUID()}.partial`;
      copyFileSync(path, partial);
      renameSync(partial, file);
    } catch { /* missing or unreadable: the line shows the file as it is */ }
  }
}

/** Drops a line's copies (the line is gone). */
export function dropLineMedia(storeDir: string, lineId: string): void {
  if (!SAFE_ID.test(lineId)) return;
  try { rmSync(folder(storeDir, lineId), { recursive: true, force: true }); } catch { /* nothing to drop */ }
}
