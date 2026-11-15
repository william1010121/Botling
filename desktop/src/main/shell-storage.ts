// Desktop main-process backing for `shell.storage` (M7-05c):
//   - Stores per-plugin namespaces in `<dataDir>/shell-storage.json` (the window's own data folder, never `core/` or a server).
//   - Symlink-safe reads and writes (L-002): `O_NOFOLLOW` + `lstat`/`fstat` dev:ino check on read; stage beside target with
//     `O_CREAT | O_EXCL | O_NOFOLLOW`, verify `dev:ino`, fsync, one same-parent rename on write.
//   - Enforces the 1 MiB per-plugin quota (`SHELL_STORAGE_QUOTA_BYTES`) and strict namespace validation (L-005, L-006).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { SHELL_STORAGE_QUOTA_BYTES, validateShellStorageNamespace } from "../renderer/shell/storage";

export const SHELL_STORAGE_CHANNEL = "botling:shellStorage";
export const SHELL_STORAGE_FILE = "shell-storage.json";
export const SHELL_STORAGE_MAX_FILE_BYTES = 64 * 1024 * 1024;

export type ShellStorageIpcRequest =
  | { op: "load"; namespace: string }
  | { op: "save"; namespace: string; json: string | null };

export function parseShellStorageRequest(raw: unknown): ShellStorageIpcRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return null;
  const msg = raw as Record<string, unknown>;
  const keys = Object.keys(msg);
  let namespace: string;
  try {
    namespace = validateShellStorageNamespace(msg.namespace);
  } catch {
    return null;
  }
  if (msg.op === "load") {
    return keys.length === 2 ? { op: "load", namespace } : null;
  }
  if (msg.op === "save") {
    if (keys.length !== 3) return null;
    if (msg.json !== null && typeof msg.json !== "string") return null;
    return { op: "save", namespace, json: msg.json };
  }
  return null;
}

function readRegularFileSafe(file: string, maxBytes: number): string | null {
  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!lstat.isFile()) throw new Error(`${SHELL_STORAGE_FILE} is not a regular file.`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fstat = fstatSync(fd);
    if (!fstat.isFile() || fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
      throw new Error(`${SHELL_STORAGE_FILE} changed during open.`);
    }
    if (fstat.size > maxBytes) {
      throw new Error(`${SHELL_STORAGE_FILE} exceeds ${maxBytes} bytes.`);
    }
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`${SHELL_STORAGE_FILE} exceeds ${maxBytes} bytes.`);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function writeFileSymlinkSafe(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${SHELL_STORAGE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const fstat = fstatSync(fd);
    const lstat = lstatSync(temp);
    if (!fstat.isFile() || !lstat.isFile() || fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) {
      throw new Error(`${SHELL_STORAGE_FILE} staging file failed verification.`);
    }
    writeSync(fd, text, undefined, "utf8");
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function parseRootNamespaces(text: string | null): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (text === null || text.trim() === "") return map;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SHELL_STORAGE_FILE} must contain a JSON object.`);
  }
  for (const ns of Object.keys(parsed)) {
    const validNs = validateShellStorageNamespace(ns);
    const entry = (parsed as Record<string, unknown>)[ns];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${SHELL_STORAGE_FILE} namespace ${JSON.stringify(validNs)} is not a JSON object.`);
    }
    const clean: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(entry)) {
      Object.defineProperty(clean, key, { value: (entry as Record<string, unknown>)[key], enumerable: true, configurable: true, writable: true });
    }
    map.set(validNs, clean);
  }
  return map;
}

function serializeRootNamespaces(map: ReadonlyMap<string, Record<string, unknown>>): string {
  const root: Record<string, unknown> = Object.create(null);
  for (const [ns, entries] of map) {
    Object.defineProperty(root, ns, { value: entries, enumerable: true, configurable: true, writable: true });
  }
  return `${JSON.stringify(root)}\n`;
}

export class DesktopShellStorage {
  readonly file: string;

  constructor(private readonly dataDir: string, private readonly quotaBytes = SHELL_STORAGE_QUOTA_BYTES) {
    this.file = join(dataDir, SHELL_STORAGE_FILE);
  }

  load(namespace: string): string | null {
    const ns = validateShellStorageNamespace(namespace);
    const namespaces = parseRootNamespaces(readRegularFileSafe(this.file, SHELL_STORAGE_MAX_FILE_BYTES));
    const entry = namespaces.get(ns);
    return entry ? JSON.stringify(entry) : null;
  }

  save(namespace: string, json: string | null): void {
    const ns = validateShellStorageNamespace(namespace);
    let parsedEntry: Record<string, unknown> | null = null;
    if (json !== null) {
      if (typeof json !== "string") throw new Error("Validation: shell storage payload must be a JSON string or null.");
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > this.quotaBytes) {
        throw new Error(`QuotaExceeded: shell storage for ${JSON.stringify(ns)} would use ${bytes} bytes (limit ${this.quotaBytes} bytes).`);
      }
      const raw = JSON.parse(json) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Validation: shell storage payload must be a JSON object.");
      }
      const clean: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(raw)) {
        Object.defineProperty(clean, key, { value: (raw as Record<string, unknown>)[key], enumerable: true, configurable: true, writable: true });
      }
      const normalizedBytes = Buffer.byteLength(JSON.stringify(clean), "utf8");
      if (normalizedBytes > this.quotaBytes) {
        throw new Error(`QuotaExceeded: shell storage for ${JSON.stringify(ns)} would use ${normalizedBytes} bytes (limit ${this.quotaBytes} bytes).`);
      }
      parsedEntry = clean;
    }
    const namespaces = parseRootNamespaces(readRegularFileSafe(this.file, SHELL_STORAGE_MAX_FILE_BYTES));
    if (parsedEntry === null || Object.keys(parsedEntry).length === 0) namespaces.delete(ns);
    else namespaces.set(ns, parsedEntry);
    const nextText = serializeRootNamespaces(namespaces);
    if (Buffer.byteLength(nextText, "utf8") > SHELL_STORAGE_MAX_FILE_BYTES) {
      throw new Error(`QuotaExceeded: ${SHELL_STORAGE_FILE} exceeds total size limit.`);
    }
    writeFileSymlinkSafe(this.file, nextText);
  }
}

export function installShellStorageIpc(
  ipc: Pick<IpcMain, "handle">,
  dataDir: string,
  fromAppFrame: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean,
  quotaBytes = SHELL_STORAGE_QUOTA_BYTES,
): DesktopShellStorage {
  const storage = new DesktopShellStorage(dataDir, quotaBytes);
  ipc.handle(SHELL_STORAGE_CHANNEL, (event, raw: unknown) => {
    if (!fromAppFrame(event)) throw new Error("Refused shell storage IPC from untrusted frame.");
    const req = parseShellStorageRequest(raw);
    if (!req) throw new Error("Validation: malformed shell storage IPC request.");
    if (req.op === "load") return storage.load(req.namespace);
    storage.save(req.namespace, req.json);
    return undefined;
  });
  return storage;
}
