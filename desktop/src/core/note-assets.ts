// A bot's note's pictures (the Note tab, 2026-11-08): copies kept beside the note in its own `note-assets/` folder
// (<project>/.bot/note-assets/, a sub bot's .bot/sub-bots/<id>/note-assets/, the main bot's <folder>/note-assets/),
// named by a hash of their bytes (the same picture is kept once) with their extension, so a note never loses a
// picture when the original moves or is deleted. The note links them relatively ("note-assets/<hash>.png").
// Only pictures (png, jpg, jpeg, gif, webp, svg) under ASSET_MAX; nothing is read but a file the note itself links
// (an absolute path, ~/… or a file: URL) or bytes the plugin hands over (a paste or a drop).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder beside the note, and the start of every ref to a picture in it. */
export const NOTE_ASSETS = "note-assets";
/** The biggest picture kept (bytes). */
export const ASSET_MAX = 20 * 1024 * 1024;
/** The biggest picture handed over as bytes (a paste or drop): base64 through the plugin host's 4 MB lines. */
export const ASSET_BYTES_MAX = 2_500_000;

export const ASSET_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};

export interface AssetFile { path: string; type: string }

/** Where a note's pictures are kept (absolute). */
export function noteAssetsDir(noteFile: string): string {
  return join(dirname(noteFile), NOTE_ASSETS);
}

const extOf = (name: string): string | null => {
  const ext = extname(name).slice(1).toLowerCase();
  return ASSET_TYPES[ext] ? ext : null;
};

/** Keeps `bytes` as note-assets/<hash>.<ext> (once: the same bytes are the same file) and gives its ref. */
function keep(noteFile: string, bytes: Buffer, ext: string): string {
  if (bytes.length > ASSET_MAX) throw new Error(`A note's picture is at most ${ASSET_MAX / 1024 / 1024} MB.`);
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext === "jpeg" ? "jpg" : ext}`;
  const dir = noteAssetsDir(noteFile);
  const file = join(dir, name);
  let have = false;
  try { have = statSync(file).size === bytes.length; } catch { /* not kept yet */ }
  if (!have) {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
  return `${NOTE_ASSETS}/${name}`;
}

/** A link's target as a file (file: URL, ~/…, absolute path); null for anything else (relative, http, data:). */
export function linkedFile(target: string): string | null {
  const value = target.trim();
  if (/^file:/i.test(value)) {
    try { return resolve(fileURLToPath(value)); } catch { return null; }
  }
  if (value.startsWith("~/")) return resolve(join(homedir(), value.slice(2)));
  if (value.startsWith("/")) {
    let path = value;
    try { path = decodeURI(value); } catch { /* kept as written */ }
    return resolve(path);
  }
  return null;
}

/** Copies a picture on disk into the note's folder. */
export function importAssetFile(noteFile: string, file: string): string {
  const ext = extOf(file);
  if (!ext) throw new Error("Only png, jpg, jpeg, gif, webp and svg pictures go in a note.");
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new Error(`No such picture: ${file}`);
  }
  if (size > ASSET_MAX) throw new Error(`A note's picture is at most ${ASSET_MAX / 1024 / 1024} MB.`);
  return keep(noteFile, readFileSync(file), ext);
}

/** Keeps a picture handed over as bytes (a paste or a drop); `name` gives only its extension. */
export function importAssetBytes(noteFile: string, bytes: Buffer, name: string): string {
  const ext = extOf(name);
  if (!ext) throw new Error("Only png, jpg, jpeg, gif, webp and svg pictures go in a note.");
  if (bytes.length > ASSET_BYTES_MAX) throw new Error(`A picture handed over as bytes is at most ${ASSET_BYTES_MAX} bytes.`);
  return keep(noteFile, bytes, ext);
}

const REF = /^(?:\.\/)?note-assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/;

/** The picture a ref ("note-assets/<name>", "./note-assets/<name>") names, only inside the note's folder; null otherwise. */
export function assetFile(noteFile: string, ref: string): AssetFile | null {
  let value = ref.trim();
  try { value = decodeURI(value); } catch { return null; }
  const match = REF.exec(value);
  const ext = match ? extOf(match[1]) : null;
  if (!match || !ext) return null;
  try {
    const dir = realpathSync(noteAssetsDir(noteFile));
    const real = realpathSync(join(dir, match[1]));
    if (dirname(real) !== dir || !statSync(real).isFile()) return null;
    return { path: real, type: ASSET_TYPES[ext] };
  } catch {
    return null;
  }
}

interface Link { start: number; end: number; target: string }

/** Where code is (fenced blocks, inline spans): a link written there is shown as text, never touched. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
  for (const m of text.matchAll(fence)) ranges.push([m.index!, m.index! + m[0].length]);
  const inside = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(/(`+)[^`\n]+?\1/g)) if (!inside(m.index!)) ranges.push([m.index!, m.index! + m[0].length]);
  return ranges;
}

/** The picture links in a note (markdown images, reference definitions, <img src>), outside code. */
function imageLinks(text: string): Link[] {
  const code = codeRanges(text);
  const outside = (i: number) => !code.some(([a, b]) => i >= a && i < b);
  const links: Link[] = [];
  const add = (index: number, offset: number, raw: string) => {
    const angled = raw.startsWith("<") && raw.endsWith(">");
    const start = index + offset + (angled ? 1 : 0);
    const target = angled ? raw.slice(1, -1) : raw;
    if (outside(index)) links.push({ start, end: start + target.length, target });
  };
  for (const m of text.matchAll(/!\[[^\]\n]*\]\([ \t]*(<[^>\n]+>|[^\s)<>]+)/g)) add(m.index!, m[0].length - m[1].length, m[1]);
  for (const m of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/gm)) add(m.index!, m[0].length - m[1].length, m[1]);
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])([^"'\n]*)\1/gi)) add(m.index!, m[0].length - m[2].length - 1, m[2]);
  return links.sort((a, b) => a.start - b.start);
}

/** The pictures on disk a note links by absolute path, ~/… or file: URL (resolved). */
export function linkedPictures(text: string): string[] {
  const found = new Set<string>();
  for (const link of imageLinks(text)) {
    const file = linkedFile(link.target);
    if (file && extOf(file)) found.add(file);
  }
  return [...found];
}

export interface Localized {
  text: string;
  /** Each picture copied in: what the note linked and the ref it now links. */
  copied: Array<{ from: string; ref: string }>;
  /** Links left as they were: the picture is not there (or is not a file). */
  missing: string[];
  /** Links left as they were: the picture could not be kept (too big, unreadable). */
  failed: Array<{ from: string; error: string }>;
}

/**
 * Copies every picture the note links by absolute path, ~/… or file: URL into its note-assets folder and links the
 * copy instead ("note-assets/<hash>.png"). Links already relative, web links and links in code are left alone; so is a
 * link whose picture is missing (it comes back in `missing`). Nothing but what the note links is read.
 */
export function localizeImages(noteFile: string, text: string): Localized {
  const copied: Localized["copied"] = [];
  const missing: string[] = [];
  const failed: Localized["failed"] = [];
  const refs = new Map<string, string | null>();
  let out = "";
  let at = 0;
  for (const link of imageLinks(text)) {
    const file = linkedFile(link.target);
    if (!file || !extOf(file)) continue;
    let ref = refs.get(file);
    if (ref === undefined) {
      ref = null;
      let isFile = false;
      try { isFile = statSync(file).isFile(); } catch { /* missing */ }
      if (!isFile) missing.push(link.target);
      else {
        try {
          ref = importAssetFile(noteFile, file);
          copied.push({ from: link.target, ref });
        } catch (error) {
          failed.push({ from: link.target, error: (error as Error).message });
        }
      }
      refs.set(file, ref);
    }
    if (!ref) continue;
    out += text.slice(at, link.start) + ref;
    at = link.end;
  }
  return { text: out + text.slice(at), copied, missing, failed };
}
