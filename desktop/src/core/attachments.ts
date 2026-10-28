// Attachments as 1.x keeps them (Models.swift `Attachment`, Bot.swift `keep`): files you send are
// copied into the bot's own attachments folder (the main bot's `attachments/`, any other bot's
// `.bot/attachments/`) as `yyyyMMdd-HHmmss-<name>` (`-2-`, `-3-`… when taken), listed for the bot as
// "(Attachments:\n- path)", and pictures go to the head too (claude: base64 blocks; Codex: localImage).
//
// Before you send, files wait in the input box (1.x's `ChatPayload.Pending`): picked ones by their
// path (main's dialog chose them), pasted or dropped ones written to `<core>/incoming/` first (1.x:
// the temp folder's `ccb-incoming`), which is emptied as they are sent or removed.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { ContractError } from "../contract";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

/** Copies a file into the attachments folder (`Bot.keep`); null when it cannot be read. */
export function keep(file: string, folder: string, date = new Date()): { path: string; url: string; kind: AttachmentKind } | null {
  try {
    mkdirSync(folder, { recursive: true });
    const name = basename(file);
    const at = stamp(date);
    let target = join(folder, `${at}-${name}`);
    for (let counter = 2; existsSync(target); counter++) target = join(folder, `${at}-${counter}-${name}`);
    copyFileSync(file, target);
    return { path: target, url: pathToFileURL(target).href, kind: attachmentKind(target) };
  } catch {
    return null;
  }
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

/** The files waiting in each bot's input box. */
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

  /** Files main's picker chose (paths that exist and are files). */
  addPaths(botId: string, paths: string[]): PendingFileView[] {
    const added: PendingFile[] = [];
    for (const path of paths) {
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
