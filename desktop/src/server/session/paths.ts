// Where botlingd keeps its files (M1 step 9, protocol v1 §6.1), the same places the Botling 3 window looks
// (main-v3/server-client.ts `serverPaths`): the data folder holds server.db, the bots' folders, `botlingd.sock` and
// `botlingd.token`. `BOTLING_SERVER_DATA_DIR` names the folder (the window's spawn passes it as `BOTLING_DATA_DIR`),
// `BOTLING_SERVER_SOCKET` moves the socket (a macOS socket path is at most 104 bytes).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface BotlingdPaths {
  dataDir: string;
  socket: string;
  token: string;
}

/** The longest Unix socket path macOS takes (sun_path is 104 bytes with its terminating zero). */
export const SOCKET_PATH_LIMIT = 103;

export class PathsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathsError";
  }
}

export function botlingdPaths(env: Record<string, string | undefined>): BotlingdPaths {
  const dataDir = env.BOTLING_SERVER_DATA_DIR || env.BOTLING_DATA_DIR;
  if (!dataDir) throw new PathsError("botlingd needs its data folder: set BOTLING_SERVER_DATA_DIR (or BOTLING_DATA_DIR).");
  const socket = env.BOTLING_SERVER_SOCKET || join(dataDir, "botlingd.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    throw new PathsError(`The socket path is ${Buffer.byteLength(socket)} bytes; macOS takes at most ${SOCKET_PATH_LIMIT}. Set BOTLING_SERVER_SOCKET to a shorter path.`);
  }
  return { dataDir, socket, token: join(dataDir, "botlingd.token") };
}

/**
 * Refuses a folder that holds Botling 2.x's data (bots' folders or settings, no server.db): botlingd keeps its own
 * folder and never writes into a 2.x one (M1: 2.x data is untouched; importing it is a later step).
 */
export function refuse2xData(dataDir: string): void {
  if (!existsSync(dataDir) || existsSync(join(dataDir, "server.db"))) return;
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return; }
  if (names.includes("projects") || names.includes("settings.json") || names.includes("main")) {
    throw new PathsError(`${dataDir} looks like a Botling 2.x data folder (it has bots or settings but no server.db); botlingd needs a folder of its own.`);
  }
}

/** A new local token (§6.1): 32 random bytes as hex, written 0600 through a temporary file and a rename. */
export function writeToken(file: string): string {
  const token = randomBytes(32).toString("hex");
  const temp = `${file}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, token);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return token;
}

export function readToken(file: string): string | null {
  try { return readFileSync(file, "utf8").trim() || null; } catch { return null; }
}

/** Compares a hello's token with ours in constant time. */
export function sameToken(given: string | undefined, ours: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ours);
  return a.length === b.length && timingSafeEqual(a, b);
}
