// Attachments (Models.swift `Attachment`, Bot.swift `keep`): a file you picked or dropped that lives on
// disk at a stable place is attached where it is, by its own path, and not copied (`original`). Anything
// else (pasted pictures, a component's pictures, files the app or a plugin hands over, and originals in a
// temporary place: see `isTemporaryPath`) is copied into the bot's own attachments folder (the main bot's
// `attachments/`, any other bot's `.bot/attachments/`) as `yyyyMMdd-HHmmss-<name>` (`-2-`, `-3-`… when
// taken), as 1.x does. Either way the message lists it for the bot as "(Attachments:\n- path)", and
// pictures go to the head too (claude: base64 blocks; Codex: localImage). Nothing here ever deletes an
// original: only the incoming copies below are removed.
//
// Before you send, files wait in the input box (1.x's `ChatPayload.Pending`): picked ones by their
// path (main's dialog chose them), pasted or dropped ones written to `<core>/incoming/` first (1.x:
// the temp folder's `ccb-incoming`), which is emptied as they are sent or removed.
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { ContractError } from "../contract";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { PendingFileView } from "../contract";

export type AttachmentKind = "image" | "video" | "file";

/** `Attachment.kind(of:)`. */
export function attachmentKind(path: string): AttachmentKind {
  switch (extname(path).slice(1).toLowerCase()) {
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "heic": case "tiff": case "bmp": return "image";
    case "mp4": case "mov": case "m4v": case "webm": return "video";
    default: return "file";
  }
}

/** Image types claude reads directly (`Attachment.mediaType`). */
export function imageMediaType(path: string): string | null {
  switch (extname(path).slice(1).toLowerCase()) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return null;
  }
}

/** Whether `text` holds `path` whole: not as the start of a longer name (`/a.png` in `/a.png.bak`). */
function holds(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const next = text[at + path.length];
    if (next === undefined || !/[\p{L}\p{N}._~%/-]/u.test(next)) return true;
  }
  return false;
}

/** Whether a line's text names this absolute path: as written, or percent-encoded in a file:// URL. */
export function namesPath(text: string, path: string): boolean {
  if (!text || !path.startsWith("/")) return false;
  if (holds(text, path)) return true;
  if (!text.includes("%")) return false;
  try { return holds(decodeURIComponent(text), path); } catch {
    // A stray "%" in the text: decode its file:// URLs one by one.
    return (text.match(/file:\/\/[^\s)\]>"']+/g) ?? []).some((url) => { try { return holds(decodeURIComponent(url), path); } catch { return false; } });
  }
}

/** What the chat origin serves a file as (anything unknown: a download-only type, never HTML). */
export function servedType(path: string): string {
  const media = imageMediaType(path);
  if (media) return media;
  switch (extname(path).slice(1).toLowerCase()) {
    case "bmp": return "image/bmp";
    case "tiff": return "image/tiff";
    case "heic": return "image/heic";
    case "mp4": case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    case "webm": return "video/webm";
    case "txt": case "md": case "log": case "csv": return "text/plain; charset=utf-8";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** How a message lists its files for the bot (`Attachment.list`). */
export function attachmentList(paths: string[]): string {
  return "(Attachments:\n" + paths.map((path) => `- ${path}`).join("\n") + ")";
}

/** The bot's attachments folder (`BotProfile.attachmentsURL`). */
export function attachmentsFolder(profile: { role: string; folder: string }): string {
  return join(profile.folder, profile.role === "main" ? "attachments" : ".bot/attachments");
}

const two = (n: number) => String(n).padStart(2, "0");
/** 1.x's stamp: local time, `yyyyMMdd-HHmmss`. */
export function stamp(date = new Date()): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * Folders whose files may vanish soon after you drop them, so an attachment from there is copied:
 * the system temp folder (`os.tmpdir()`, on macOS inside `/var/folders/…/T/`), all of `/var/folders`
 * (per-user temp and caches: `TemporaryItems`, the screenshot thumbnail's drag file
 * `NSIRD_screencaptureui_*`, Electron's and other apps' drag files), `/tmp`, `/var/tmp` (and their
 * `/private/…` real paths), `~/Library/Caches`, the Trash (`~/.Trash`), a sandboxed app's own `tmp` and
 * `Library/Caches` (`~/Library/Containers/<app>/Data/…`, CleanShot X's temporary captures among them)
 * and CleanShot's own capture folder in Application Support.
 */
export function temporaryRoots(home = homedir(), temp = tmpdir()): string[] {
  return [temp, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders",
    join(home, "Library/Caches"), join(home, ".Trash"), join(home, "Library/Application Support/CleanShot")];
}

/** Path patterns that are temporary wherever they sit (a sandboxed app's own temp and caches). */
const TEMPORARY_PATTERNS = [/[\\/]Library[\\/]Containers[\\/][^\\/]+[\\/]Data[\\/](tmp|Library[\\/]Caches)[\\/]/];

const inside = (path: string, root: string) => {
  const folder = root.endsWith(sep) ? root.slice(0, -1) : root;
  return !!folder && (path === folder || path.startsWith(folder + sep));
};

/** Whether a file sits in a temporary place (`temporaryRoots`), as written or through symlinks. */
export function isTemporaryPath(path: string, roots = temporaryRoots()): boolean {
  const seen = [resolve(path)];
  try { seen.push(realpathSync(path)); } catch { /* A missing file: its path as written. */ }
  const allRoots = roots.flatMap((root) => { try { return [resolve(root), realpathSync(root)]; } catch { return [resolve(root)]; } });
  return seen.some((candidate) => allRoots.some((root) => inside(candidate, root)) || TEMPORARY_PATTERNS.some((pattern) => pattern.test(candidate)));
}

export interface KeepOptions {
  /** The user picked or dropped this file from disk: attached where it is unless it is temporary. */
  original?: boolean;
  /** What counts as temporary (tests): `temporaryRoots()` by default. */
  temporary?: string[];
}

/**
 * A file for a message: an original attached by its own path (`copied: false`), or a copy in the
 * attachments folder (`Bot.keep`); null when it cannot be read.
 */
export function keep(file: string, folder: string, date = new Date(), options: KeepOptions = {}): { path: string; url: string; kind: AttachmentKind; copied: boolean } | null {
  try {
    if (options.original && isAbsolute(file) && !isTemporaryPath(file, options.temporary)) {
      const path = resolve(file);
      if (!statSync(path).isFile()) return null;
      return { path, url: pathToFileURL(path).href, kind: attachmentKind(path), copied: false };
    }
    mkdirSync(folder, { recursive: true });
    const name = basename(file);
    const at = stamp(date);
    let target = join(folder, `${at}-${name}`);
    for (let counter = 2; existsSync(target); counter++) target = join(folder, `${at}-${counter}-${name}`);
    copyFileSync(file, target);
    return { path: target, url: pathToFileURL(target).href, kind: attachmentKind(target), copied: true };
  } catch {
    return null;
  }
}

/** Whether a line's file:// attachment is no longer there (an original moved or deleted, say). */
export function attachmentMissing(url: string): boolean {
  if (!url.startsWith("file:")) return false;
  try { return !statSync(fileURLToPath(url)).isFile(); } catch { return true; }
}

/** Writes a picture a page handed over (`{name, base64}`) to the incoming folder; null when empty. */
export function writeIncoming(dir: string, name: string, base64: string): string | null {
  const data = Buffer.from(base64, "base64");
  if (!data.length) return null;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID().slice(0, 6).toUpperCase()}-${safeName(name)}`);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}

/** How an answer of only pictures shows (`Bot.answerLabel`). */
export function answerLabel(text: string, files: number): string {
  const words = text.trim();
  if (words || !files) return words;
  return files === 1 ? "(picture)" : `(${files} pictures)`;
}

export interface PendingFile { id: string; name: string; path: string; kind: AttachmentKind; incoming: boolean }

/** A name a pasted file may keep: no folders, no leading dots, no control characters. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replaceAll("/", "-").replaceAll("\\", "-").replace(/[\u0000-\u001f]/g, "").replace(/^\.+/, "").trim();
  return (cleaned || "file").slice(0, 200);
}

/**
 * The files waiting in each bot's input box. `incoming: true` files are this app's own copies (pasted or
 * read by the page) and are deleted once sent or removed; any other is the user's file on disk, never deleted.
 */
export class PendingFiles {
  private readonly byBot = new Map<string, PendingFile[]>();
  private readonly writes = new Map<string, number>();

  constructor(private readonly incomingDir: string, private readonly onChange: (botId: string, files: PendingFileView[]) => void) {}

  list(botId: string): PendingFile[] {
    return this.byBot.get(botId) ?? [];
  }

  views(botId: string): PendingFileView[] {
    return this.list(botId).map(({ id, name, kind }) => ({ id, name: name.slice(0, 400), kind }));
  }

  get(botId: string, id: string): PendingFile | undefined {
    return this.list(botId).find((file) => file.id === id);
  }

  private set(botId: string, files: PendingFile[]) {
    if (files.length) this.byBot.set(botId, files.slice(0, 50));
    else this.byBot.delete(botId);
    this.onChange(botId, this.views(botId));
  }

  /** Files main's picker chose or the chat page had dropped on it (paths that exist and are files). */
  addPaths(botId: string, paths: string[]): PendingFileView[] {
    const added: PendingFile[] = [];
    for (const path of paths) {
      if (!isAbsolute(path)) continue;
      try { if (!statSync(path).isFile()) continue; } catch { continue; }
      added.push({ id: randomUUID().toUpperCase(), name: basename(path), path, kind: attachmentKind(path), incoming: false });
    }
    this.set(botId, [...this.list(botId), ...added]);
    return this.views(botId);
  }

  /** A pasted or dropped file the page read (`addFileData`), written to the incoming folder. */
  async addData(botId: string, name: string, base64: string): Promise<PendingFileView[]> {
    if (this.list(botId).length + (this.writes.get(botId) ?? 0) >= 50) throw new ContractError("bad_request", "At most 50 attachments can wait in a chat.");
    const data = Buffer.from(base64, "base64");
    if (!data.length) throw new ContractError("bad_request", "The attachment is empty.");
    this.writes.set(botId, (this.writes.get(botId) ?? 0) + 1);
    const id = randomUUID().toUpperCase();
    const safe = safeName(name);
    const path = join(this.incomingDir, `${id}-${safe}`);
    let created = false;
    try {
      await mkdir(this.incomingDir, { recursive: true });
      const handle = await open(path, "wx", 0o600);
      created = true;
      try { await handle.writeFile(data); } finally { await handle.close(); }
      // A native picker may have added files while the disk write was pending.
      if (this.list(botId).length >= 50) throw new ContractError("bad_request", "At most 50 attachments can wait in a chat.");
      this.set(botId, [...this.list(botId), { id, name: safe, path, kind: attachmentKind(path), incoming: true }]);
      return this.views(botId);
    } catch (error) {
      if (created) await rm(path, { force: true }).catch(() => {});
      throw error;
    } finally {
      const remaining = (this.writes.get(botId) ?? 1) - 1;
      if (remaining) this.writes.set(botId, remaining); else this.writes.delete(botId);
    }
  }

  remove(botId: string, id: string): PendingFileView[] {
    const file = this.get(botId, id);
    if (file?.incoming) rmSync(file.path, { force: true });
    this.set(botId, this.list(botId).filter((candidate) => candidate.id !== id));
    return this.views(botId);
  }

  /** All of a bot's waiting files, for the message being sent (the incoming copies go once kept). */
  take(botId: string): PendingFile[] {
    const files = this.list(botId);
    if (files.length) this.set(botId, []);
    return files;
  }

  /** Removes what `take` handed out once it was kept. */
  done(files: PendingFile[]) {
    for (const file of files) if (file.incoming) rmSync(file.path, { force: true });
  }

  /** Puts files back (the message could not be sent). */
  restore(botId: string, files: PendingFile[]) {
    if (files.length) this.set(botId, [...files, ...this.list(botId)]);
  }
}
