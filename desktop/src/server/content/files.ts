// Which local files a finished chat line names (protocol v1 §9A.2), and what they are served as.
//
// The renderer turns a line's local file links into chat-origin URLs (contract/attachment-url.ts `localMediaSource`):
// file:// URLs anywhere in the text, and absolute paths as a Markdown image or link target. The same two forms are read
// here, plus the line's attachments (their file:// URLs). Each file is known by its absolute path; the renderer's
// `file://` text and this path are matched with `pathOfFileRef`.
//
// Indexed kinds: pictures, video, audio and PDFs. Other files (archives, data, code) are not indexed in M1: a line that
// links one opens it through the 2.x path. A file on the protected list (§9A.2, §16: keys, keychains, `.ssh`, browser
// profiles, Botling's own data folder) is never indexed.
import { isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentRef } from "../../protocol";

export type ContentKind = ContentRef["kind"];

const TYPES: Record<string, { type: string; kind: ContentKind }> = {
  png: { type: "image/png", kind: "image" },
  jpg: { type: "image/jpeg", kind: "image" },
  jpeg: { type: "image/jpeg", kind: "image" },
  gif: { type: "image/gif", kind: "image" },
  webp: { type: "image/webp", kind: "image" },
  bmp: { type: "image/bmp", kind: "image" },
  tiff: { type: "image/tiff", kind: "image" },
  heic: { type: "image/heic", kind: "image" },
  svg: { type: "image/svg+xml", kind: "image" },
  mp4: { type: "video/mp4", kind: "video" },
  m4v: { type: "video/mp4", kind: "video" },
  mov: { type: "video/quicktime", kind: "video" },
  webm: { type: "video/webm", kind: "video" },
  mp3: { type: "audio/mpeg", kind: "audio" },
  m4a: { type: "audio/mp4", kind: "audio" },
  wav: { type: "audio/wav", kind: "audio" },
  ogg: { type: "audio/ogg", kind: "audio" },
  pdf: { type: "application/pdf", kind: "pdf" },
};

/** The type and kind a path is served as, or null when it is not an indexed kind. */
export function contentTypeOf(path: string): { type: string; kind: ContentKind } | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return null;
  return TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The absolute path a file reference names: a `file://` URL (as written in a line, or `file://` + a raw path, as the
 * renderer builds for an absolute Markdown target), or an absolute path. Null for anything else.
 */
export function pathOfFileRef(ref: string): string | null {
  if (!ref || ref.includes("\0")) return null;
  let path: string;
  if (/^file:/i.test(ref)) {
    try { path = fileURLToPath(new URL(ref)); } catch { return null; }
  } else if (ref.startsWith("/") && !ref.startsWith("//")) {
    try { path = decodeURIComponent(ref); } catch { path = ref; }
  } else return null;
  if (!isAbsolute(path)) return null;
  return normalize(path);
}

/** Folders whose files are never indexed (§16's deny list, local part). `dataDir`: the server's own data folder. */
export function isProtectedPath(path: string, options: { dataDir?: string; home?: string } = {}): boolean {
  const parts = path.split(sep);
  if (parts.some((part) => part === ".ssh" || part === ".gnupg" || part === ".aws" || part === ".kube")) return true;
  const lower = path.toLowerCase();
  if (lower.includes("/library/keychains/")) return true;
  if (/\/library\/application support\/(google\/chrome|chromium|bravesoftware|microsoft edge|arc|firefox)\//.test(lower)) return true;
  if (lower.includes("/library/cookies/")) return true;
  if (options.dataDir) {
    const data = normalize(options.dataDir).replace(/\/+$/, "");
    if (path === data || path.startsWith(data + sep)) return true;
  }
  return false;
}

export interface NamedFile {
  /** Absolute, normalized. */
  path: string;
  type: string;
  kind: ContentKind;
  name: string;
}

/** A chat line as the indexer reads it: its text and its attachments' URLs (the contract's MessageView has both). */
export interface LineLike {
  id: string;
  text?: string;
  attachments?: ReadonlyArray<{ url: string; name?: string }>;
}

/** At most this many files are indexed per line. */
export const FILES_PER_LINE_LIMIT = 20;

/** The local files of an indexed kind a line names, in order of first appearance, without duplicates. */
export function namedFiles(line: LineLike, options: { dataDir?: string } = {}): NamedFile[] {
  const refs: string[] = [];
  const text = line.text ?? "";
  for (const match of text.matchAll(/file:\/\/[^\s)\]>"'<]+/g)) refs.push(match[0]);
  for (const match of text.matchAll(/\]\((\/[^\s)]+)\)/g)) if (!match[1]!.startsWith("//")) refs.push(match[1]!);
  for (const file of line.attachments ?? []) if (typeof file.url === "string") refs.push(file.url);
  const out: NamedFile[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const path = pathOfFileRef(ref);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const typed = contentTypeOf(path);
    if (!typed || isProtectedPath(path, options)) continue;
    out.push({ path, ...typed, name: path.slice(path.lastIndexOf(sep) + 1).slice(0, 1_000) || "file" });
    if (out.length >= FILES_PER_LINE_LIMIT) break;
  }
  return out;
}
