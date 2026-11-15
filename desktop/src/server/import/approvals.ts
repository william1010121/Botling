// M6-02c: import 2.x user approvals (folders.json, approved-commands.json) into botlingd's data folder,
// remapping paths inside the 2.x data folder to their 3.x locations while keeping external paths intact,
// and verify per-bot `alwaysAllowed` rules carried over with `bot.json` (M6-01c).
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Db } from "../store/sqlite";
import type { IdMapRow } from "./id-map";

export interface BotApprovalRef {
  oldId: string;
  newId: string;
  name: string;
  chatDir: string;
}

export interface AlwaysAllowedCheck {
  oldId: string;
  newId: string;
  name: string;
  expected: string[];
  present: string[];
  missing: string[];
}

export interface ImportApprovalsOptions {
  sourceDir: string;
  targetDir: string;
  idMap?: readonly Pick<IdMapRow, "oldId" | "newId" | "kind">[];
  /** Optional open server.db connection used to confirm `alwaysAllowed` rules in `bots.settings`. */
  db?: Db;
  /** Optional bot list whose 2.x `bot.json` `alwaysAllowed` entries should be audited. */
  bots?: readonly BotApprovalRef[];
}

export interface ImportApprovalsReport {
  folders: string[];
  movedFolders: Array<{ from: string; to: string }>;
  approvedCommands: Record<string, string[]>;
  movedCommandFolders: Array<{ from: string; to: string }>;
  alwaysAllowed: AlwaysAllowedCheck[];
  alwaysAllowedCount: number;
  problems: string[];
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a file strictly read-only; returns null when missing or not a regular file. */
function readFileReadOnly(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomic(file: string, content: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.tmp-${process.pid}-${Date.now()}`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "w", 0o600);
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Maps a 2.x folder path to its 3.x location:
 * - paths outside `sourceDir` are kept as-is (resolved);
 * - paths inside `sourceDir` move to the matching relative path under `targetDir`, respecting
 *   `idMap` when the 2.x main bot became a non-designated standalone bot (`main-as-bot`) or a
 *   standalone bot id was re-minted on clash.
 */
export function remapApprovalPath(
  folder: string,
  sourceDir: string,
  targetDir: string,
  idMap?: readonly Pick<IdMapRow, "oldId" | "newId" | "kind">[],
): string {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  const from = resolve(folder);
  if (!inside(from, source)) return from;

  if (idMap && idMap.length > 0) {
    const sourceMain = join(source, "main");
    if (inside(from, sourceMain)) {
      const mainAsBot = idMap.find((row) => row.kind === "main-as-bot");
      if (mainAsBot) {
        const tail = relative(sourceMain, from);
        return tail ? join(target, "bots", mainAsBot.newId, tail) : join(target, "bots", mainAsBot.newId);
      }
    }

    const sourceBots = join(source, "bots");
    if (inside(from, sourceBots) && from !== sourceBots) {
      const relBots = relative(sourceBots, from);
      const parts = relBots.split(sep).filter(Boolean);
      const oldBotDir = parts[0];
      if (oldBotDir) {
        const mapped = idMap.find(
          (row) => row.kind === "bot" && row.oldId.toUpperCase() === oldBotDir.toUpperCase(),
        );
        if (mapped && mapped.oldId.toUpperCase() !== mapped.newId.toUpperCase()) {
          return join(target, "bots", mapped.newId, ...parts.slice(1));
        }
      }
    }
  }

  const rel = relative(source, from);
  return rel ? join(target, rel) : target;
}

/** Reads `alwaysAllowed` entries from a 2.x `<chatDir>/bot.json` file, strictly read-only. */
export function readAlwaysAllowed(chatDir: string, problems?: string[]): string[] {
  const file = join(chatDir, "bot.json");
  let raw: string | null;
  try {
    raw = readFileReadOnly(file);
  } catch (error) {
    problems?.push(`${file}: could not be read (${errorText(error)})`);
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      problems?.push(`${file}: not an object`);
      return [];
    }
    return stringList(parsed.alwaysAllowed);
  } catch (error) {
    problems?.push(`${file}: not valid JSON (${errorText(error)})`);
    return [];
  }
}

function readDbAlwaysAllowed(db: Db, botId: string): string[] {
  const row = db.prepare("SELECT settings FROM bots WHERE botId = ?").get(botId);
  if (!row || typeof row.settings !== "string") return [];
  try {
    const parsed = JSON.parse(row.settings) as unknown;
    return isPlainObject(parsed) ? stringList(parsed.alwaysAllowed) : [];
  } catch {
    return [];
  }
}

/**
 * Imports 2.x `folders.json` and `approved-commands.json` into `targetDir` and verifies `alwaysAllowed`
 * entries from 2.x `bot.json` files (which M6-01c copies into `server.db`). Never modifies `sourceDir`.
 */
export function importApprovals(options: ImportApprovalsOptions): ImportApprovalsReport {
  const source = resolve(options.sourceDir);
  const target = resolve(options.targetDir);
  if (inside(target, source) || inside(source, target)) {
    throw new Error("The import's source and target must be separate folders.");
  }

  const problems: string[] = [];
  const folders: string[] = [];
  const movedFolders: Array<{ from: string; to: string }> = [];
  const approvedCommands: Record<string, string[]> = {};
  const movedCommandFolders: Array<{ from: string; to: string }> = [];

  // 1. folders.json (folders Maintainer may read)
  const foldersFile = join(source, "folders.json");
  let foldersText: string | null = null;
  try {
    foldersText = readFileReadOnly(foldersFile);
  } catch (error) {
    problems.push(`folders.json: could not be read (${errorText(error)})`);
  }
  if (foldersText !== null) {
    try {
      const value = JSON.parse(foldersText) as unknown;
      if (!Array.isArray(value)) {
        problems.push("folders.json: not a list");
      } else {
        const seen = new Set<string>();
        for (const entry of value) {
          if (typeof entry !== "string" || !isAbsolute(entry)) continue;
          const from = resolve(entry);
          const to = remapApprovalPath(from, source, target, options.idMap);
          if (!seen.has(to)) {
            seen.add(to);
            folders.push(to);
            if (to !== from) movedFolders.push({ from, to });
          }
        }
        writeFileAtomic(join(target, "folders.json"), JSON.stringify(folders));
      }
    } catch (error) {
      problems.push(`folders.json: not valid JSON (${errorText(error)})`);
    }
  }

  // 2. approved-commands.json (component commands approved per folder)
  const approvedFile = join(source, "approved-commands.json");
  let approvedText: string | null = null;
  try {
    approvedText = readFileReadOnly(approvedFile);
  } catch (error) {
    problems.push(`approved-commands.json: could not be read (${errorText(error)})`);
  }
  if (approvedText !== null) {
    try {
      const value = JSON.parse(approvedText) as unknown;
      if (!isPlainObject(value)) {
        problems.push("approved-commands.json: not a folder-to-commands object");
      } else {
        const movedSeen = new Set<string>();
        for (const [folder, rawCommands] of Object.entries(value)) {
          if (!isAbsolute(folder) || !Array.isArray(rawCommands)) continue;
          const commands = rawCommands.filter(
            (command): command is string => typeof command === "string" && command.length > 0,
          );
          if (commands.length === 0) continue;
          const from = resolve(folder);
          const to = remapApprovalPath(from, source, target, options.idMap);
          if (to !== from && !movedSeen.has(from)) {
            movedSeen.add(from);
            movedCommandFolders.push({ from, to });
          }
          approvedCommands[to] = [...new Set([...(approvedCommands[to] ?? []), ...commands])].sort();
        }
        const sorted = Object.fromEntries(
          Object.entries(approvedCommands).sort(([a], [b]) => a.localeCompare(b)),
        );
        for (const key of Object.keys(approvedCommands)) delete approvedCommands[key];
        Object.assign(approvedCommands, sorted);
        writeFileAtomic(join(target, "approved-commands.json"), JSON.stringify(sorted, null, 2));
      }
    } catch (error) {
      problems.push(`approved-commands.json: not valid JSON (${errorText(error)})`);
    }
  }

  // 3. alwaysAllowed (comes with bot.json in M6-01c; read 2.x expectations and verify against server.db if open)
  const alwaysAllowed: AlwaysAllowedCheck[] = [];
  let alwaysAllowedCount = 0;
  for (const bot of options.bots ?? []) {
    const expected = existsSync(bot.chatDir) ? readAlwaysAllowed(bot.chatDir, problems) : [];
    alwaysAllowedCount += expected.length;
    const present = options.db ? readDbAlwaysAllowed(options.db, bot.newId) : [];
    const missing = options.db ? expected.filter((entry) => !present.includes(entry)) : [];
    if (missing.length > 0) {
      problems.push(
        `alwaysAllowed for ${bot.name} (${bot.newId}): missing ${missing.length} entry(ies) in server.db (${missing.join(", ")})`,
      );
    }
    alwaysAllowed.push({
      oldId: bot.oldId,
      newId: bot.newId,
      name: bot.name,
      expected,
      present,
      missing,
    });
  }

  return {
    folders,
    movedFolders,
    approvedCommands,
    movedCommandFolders,
    alwaysAllowed,
    alwaysAllowedCount,
    problems,
  };
}
