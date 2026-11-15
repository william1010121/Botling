// 2.x -> 3.x full import runner (protocol v1 §14.4, §17; M6-01d).
//
// Orders the steps:
//   reader -> id map -> chats (+ lists) -> approvals -> settings -> plugins -> tiers -> media -> report
//
// Strictly read-only on the 2.x source folder: source files are opened only for reading and never modified,
// locked, or renamed. Holds botlingd's data-folder lock for the whole non-dry-run import, refuses when
// botlingd is running or when the same source was already imported into this folder, and writes the final
// `import:<sha256(realSourcePath)>` meta marker only after all steps succeed so a partial run can resume
// without doubling any line.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageView } from "../../core/bot";
import { writeFileAtomic } from "../../core/durable/atomic";
import { PluginRegistry } from "../../core/plugins/registry";
import { MemorySecretStore } from "../../core/plugins/secrets";
import { readSettings, writeSettings, type RawSettings } from "../../core/settings";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, readLockHolder } from "../../core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID, type ProjectRecord } from "../../core/store/records";
import { Layout, loadProjects } from "../../core/store/workspace";
import { canonicalJson } from "../../protocol";
import { RowKey } from "../../protocol/table-rows";
import { DbBotStores } from "../botstore";
import { BOTLINGD_VERSION } from "../botlingd";
import { fitBody } from "../effects/fit";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../identity/keys";
import { installedFromRegistry, reconcilePluginRows } from "../replica/plugin-rows";
import { ownTableStream } from "../replica/tables";
import { PrefsStore } from "../roster/prefs";
import { refuse2xData } from "../session/paths";
import { openServerStore, type Db } from "../store";
import { openReaderDb } from "../store/connection";
import { importApprovals, readAlwaysAllowed, remapApprovalPath, type BotApprovalRef } from "./approvals";
import { importBotChat, type ImportChatsOptions, type ImportedBotLists } from "./chats";
import { liveBotIds, mapIds, readIdMap, saveIdMap, type IdMapRow } from "./id-map";
import { importPlugins } from "./plugins";
import { looksLike2x, read2x, readChat, type Read2xBot } from "./reader-2x";
import {
  formatImportReport,
  readPluginReportEntries,
  type ImportBotReportEntry,
  type PluginReportDryRunEntry,
  type PluginReportEntry,
} from "./report";
import { mapSettings } from "./settings-map";

export class ImportError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface RunImportOptions {
  sourceDir: string;
  targetDir: string;
  dryRun?: boolean;
  designated?: boolean;
  mainId?: string;
  maintainerId?: string;
  builtInsDir?: string | null;
  now?: () => number;
  log?: (line: string) => void;
  onBatch?: ImportChatsOptions["onBatch"];
  onBotDone?: (info: { oldId: string; newId: string; index: number; total: number }) => void;
}

export interface RunImportResult {
  dryRun: boolean;
  sourceRealPath: string;
  sourceHash: string;
  reportPath: string;
  reportText: string;
  bots: ImportBotReportEntry[];
  totalLines: number;
  totalSkipped: number;
  totalPins: number;
  problems: string[];
}

export function importSourceMetaKey(sourceHash: string): string {
  return `import:${sourceHash}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderPid(dataDir: string): number | null {
  const holder = readLockHolder(dataDir);
  return holder && alive(holder.pid) ? holder.pid : null;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const FIRMLINK_DATA = "/System/Volumes/Data";

/**
 * The real path as the file system spells it. The OS realpath (`realpathSync.native`), not Node's JS one: on a
 * case-insensitive volume (the Mac's default) the JS one keeps the caller's case, so `/x/V2` and `/x/v2` would look like
 * two folders. Every path used to compare or identify folders here goes through it.
 */
function realPath(path: string): string {
  const real = realpathSync.native(path);
  // A macOS firmlink spelling (/System/Volumes/Data/Users/... for /Users/...) is not folded by any realpath: fold it
  // when the short spelling is the same folder, so one folder has one identity (`sourceHash`) and one spelling.
  if (process.platform === "darwin" && real.startsWith(`${FIRMLINK_DATA}/`)) {
    const short = real.slice(FIRMLINK_DATA.length);
    try {
      const a = statSync(real);
      const b = statSync(short);
      if (a.dev === b.dev && a.ino === b.ino) return short;
    } catch {
      // the short spelling is not there: keep the long one
    }
  }
  return real;
}

/** The ancestors of `path` (itself first) that exist, with their device and inode. */
function existingChain(path: string): { dev: number; ino: number }[] {
  const chain: { dev: number; ino: number }[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const stat = statSync(current);
      chain.push({ dev: stat.dev, ino: stat.ino });
    } catch {
      // not there (yet): only existing folders can be shared
    }
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * True when one folder is the other or inside it, by device and inode as well as by path: catches spellings no
 * realpath folds (macOS firmlinks such as /System/Volumes/Data/Users, a case-insensitive volume reached by another
 * path).
 */
function sameOrNested(a: string, b: string): boolean {
  if (isInside(a, b) || isInside(b, a)) return true;
  const chainA = existingChain(a);
  const chainB = existingChain(b);
  // `b` is `a` or one of a's existing ancestors (a may not exist yet: its nearest existing folder stands in for it),
  // or the other way round. A folder that does not exist cannot contain the other one.
  const nodeA = existsSync(a) ? chainA[0] : undefined;
  const nodeB = existsSync(b) ? chainB[0] : undefined;
  const has = (chain: readonly { dev: number; ino: number }[], node: { dev: number; ino: number } | undefined) =>
    node !== undefined && chain.some((other) => other.dev === node.dev && other.ino === node.ino);
  return has(chainA, nodeB) || has(chainB, nodeA);
}

/** `path` with symlinks resolved, also when its last parts do not exist yet (the nearest existing folder is resolved). */
function realPathOrNearest(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realPath(current), ...tail);
  } catch {
    return join(current, ...tail);
  }
}

/** Throws before a write that would land in the 2.x folder. Every write of the import goes through one. */
type WriteGuard = (path: string) => void;

/**
 * Where a write to `path` lands: its real path, or its nearest existing parent's real path plus the rest. A symbolic
 * link on the way that points nowhere is refused: creating a file through it would create the link's target, wherever
 * that is.
 */
function writeDestination(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    let isLink = false;
    let present = true;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      present = false;
    }
    if (present) {
      if (isLink && !existsSync(current)) {
        throw new ImportError(`${current} is a broken symbolic link; the import does not write through it.`, 2);
      }
      return join(realPath(current), ...tail);
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The guard for one import: a write is refused when its destination is the 2.x folder or inside it, by real path or by
 * device and inode (a symlink, another case, a firmlink, a bind mount). The 2.x folder is never written, even through a
 * link the user made in botlingd's folder.
 */
function makeWriteGuard(sourceReal: string): WriteGuard {
  const source = statSync(sourceReal);
  return (path) => {
    const real = writeDestination(path);
    const inside =
      isInside(real, sourceReal) ||
      existingChain(real).some((node) => node.dev === source.dev && node.ino === source.ino);
    if (inside) {
      throw new ImportError(`${path} leads into the Botling 2 folder, which the import never changes; nothing was written there.`, 2);
    }
  };
}

/** The target folder and each entry at its top, checked before the lock, server.db and the identity are written. */
function guardTargetTop(targetDir: string, guard: WriteGuard): void {
  guard(targetDir);
  let names: string[] = [];
  try {
    names = readdirSync(targetDir);
  } catch {
    return;
  }
  for (const name of names.sort()) guard(join(targetDir, name));
}

/** The 2.x plugin-secrets.json's device and inode, so a hard link to it is not copied either. */
function secretsNode(sourceReal: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(join(sourceReal, "plugin-secrets.json"));
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameNode(stat: { dev: number; ino: number }, node: { dev: number; ino: number } | null): boolean {
  return node !== null && stat.dev === node.dev && stat.ino === node.ino;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseImportedAt(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at === "string" && parsed.at) return parsed.at;
  } catch {
    // fall back to raw string
  }
  return raw;
}

function defaultBuiltInsDir(): string | null {
  const envDir = process.env.BOTLING_BUILTIN_PLUGINS;
  if (envDir && existsSync(envDir)) return envDir;
  const candidate = join(__dirname, "..", "builtin-plugins");
  if (existsSync(candidate)) return candidate;
  return null;
}

function readFileReadOnly(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeBytesAtomic(file: string, data: Buffer, guard: WriteGuard): void {
  guard(file);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function copyTreeReadOnly(srcDir: string, dstDir: string, srcBoundary: string, guard: WriteGuard): void {
  if (!existsSync(srcDir)) return;
  let rootStat;
  try {
    rootStat = lstatSync(srcDir);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  const srcRootReal = realPath(srcBoundary);
  const secrets = secretsNode(srcRootReal);
  guard(dstDir);
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const srcPath = join(srcDir, entry.name);
    if (srcPath === join(srcBoundary, "plugin-secrets.json") || srcPath === join(srcRootReal, "plugin-secrets.json")) continue;
    const dstPath = join(dstDir, entry.name);
    let stat;
    try {
      stat = lstatSync(srcPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        const real = realPath(srcPath);
        if (!isInside(real, srcRootReal)) continue;
        if (real === join(srcRootReal, "plugin-secrets.json")) continue;
        const realStat = statSync(real);
        if (realStat.isDirectory() || sameNode(realStat, secrets)) continue;
        const data = readFileReadOnly(real);
        if (data !== null) writeBytesAtomic(dstPath, data, guard);
      } catch (error) {
        if (error instanceof ImportError) throw error;
        continue;
      }
      continue;
    }
    if (stat.isDirectory()) {
      copyTreeReadOnly(srcPath, dstPath, srcBoundary, guard);
    } else if (stat.isFile()) {
      if (sameNode(stat, secrets)) continue; // a hard link to plugin-secrets.json
      const data = readFileReadOnly(srcPath);
      if (data !== null) writeBytesAtomic(dstPath, data, guard);
    }
  }
}

function copyIfMissing(srcFile: string, dstFile: string, guard: WriteGuard): void {
  if (existsSync(dstFile)) return;
  const data = readFileReadOnly(srcFile);
  if (data !== null) {
    guard(dstFile);
    mkdirSync(dirname(dstFile), { recursive: true });
    writeBytesAtomic(dstFile, data, guard);
  }
}

function countListItems(rawBody: unknown): number {
  if (typeof rawBody !== "string") return 0;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function readExistingBotCounts(db: Db, botId: string): { lines: number; lists: ImportedBotLists } {
  const lines = Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE botId = ?").get(botId)?.n ?? 0);
  const pinsRow = db.prepare("SELECT body FROM lists WHERE botId = ? AND name = 'pins.json'").get(botId);
  const specsRow = db.prepare("SELECT body FROM lists WHERE botId = ? AND name = 'specs.json'").get(botId);
  const tasksRow = db.prepare("SELECT body FROM lists WHERE botId = ? AND name = 'tasks.json'").get(botId);
  const subagents = Number(
    db.prepare("SELECT COUNT(*) AS n FROM rows WHERE stream = ? AND deleted = 0").get(`subagents:${botId}`)?.n ?? 0,
  );
  const subagentSteps = Number(
    db
      .prepare("SELECT COUNT(*) AS n FROM rows WHERE substr(stream, 1, ?) = ? AND deleted = 0")
      .get(`substeps:[${JSON.stringify(botId)},`.length, `substeps:[${JSON.stringify(botId)},`)?.n ?? 0,
  );
  return {
    lines,
    lists: {
      pins: countListItems(pinsRow?.body),
      missingPinLines: 0,
      specs: countListItems(specsRow?.body),
      tasks: countListItems(tasksRow?.body),
      subagents,
      subagentSteps,
      problems: [],
    },
  };
}

function prepareDryRunBot(bot: Read2xBot, newId: string): {
  lines: number;
  skipped: number;
  lists: ImportedBotLists;
  problems: string[];
} {
  const chatData = readChat(bot);
  let lines = 0;
  let skipped = 0;
  const knownUpper = new Set<string>();
  for (const record of chatData.chat) {
    try {
      const view = messageView(record);
      const fitted = fitBody("message.added", { botId: newId, message: view });
      if (fitted.dropped) {
        skipped += 1;
      } else {
        lines += 1;
        knownUpper.add(view.id.toUpperCase());
      }
    } catch {
      skipped += 1;
    }
  }

  let missingPinLines = 0;
  for (const pin of chatData.pins) {
    if (!pin || typeof pin !== "object" || Array.isArray(pin)) continue;
    const obj = pin as Record<string, unknown>;
    const id =
      typeof obj.messageId === "string" && obj.messageId
        ? obj.messageId
        : typeof obj.messageID === "string" && obj.messageID
          ? obj.messageID
          : null;
    if (id !== null && !knownUpper.has(id.toUpperCase())) missingPinLines += 1;
  }

  let subagentSteps = 0;
  for (const sub of chatData.subagents) {
    for (const run of sub.history.runs) subagentSteps += run.steps.length;
    subagentSteps += sub.history.steps.length;
  }

  return {
    lines,
    skipped,
    lists: {
      pins: chatData.pins.length,
      missingPinLines,
      specs: chatData.specs.length,
      tasks: chatData.tasks.length,
      subagents: chatData.subagents.length,
      subagentSteps,
      problems: [],
    },
    problems: chatData.problems,
  };
}

/** The 2.x bots the id map covers; one added to 2.x after this import started is left out and named in problems. */
function mappedBots(bots: readonly Read2xBot[], mapByOld: ReadonlyMap<string, IdMapRow>, problems: string[]): Read2xBot[] {
  return bots.filter((bot) => {
    if (mapByOld.has(bot.id)) return true;
    problems.push(`${bot.name} (${bot.id}): added to Botling 2 after this import started; not imported`);
    return false;
  });
}

function reconstructIdMap(
  bots: readonly Read2xBot[],
  stored: readonly { oldId: string; newId: string; kind: IdMapRow["kind"] }[],
): IdMapRow[] {
  const byOldId = new Map(bots.map((bot) => [bot.id.toUpperCase(), bot]));
  return stored.map((row) => {
    const bot = byOldId.get(row.oldId.toUpperCase());
    const name = row.kind === "main-as-bot" ? "Main (old)" : (bot?.name ?? row.oldId);
    const clash = row.kind === "bot" && row.newId.toUpperCase() !== row.oldId.toUpperCase();
    return {
      oldId: row.oldId,
      newId: row.newId,
      kind: row.kind,
      name,
      ...(clash ? { clash: true } : {}),
    };
  });
}

function writeImportedWorkspaceFiles(
  sourceReal: string,
  targetDir: string,
  sourceProjects: readonly ProjectRecord[],
  idMap: readonly IdMapRow[],
  mainId: string,
  maintainerId: string,
  problems: string[],
  guard: WriteGuard,
): void {
  const mapByOld = new Map(idMap.map((row) => [row.oldId.toUpperCase(), row]));
  const botsRoot = join(sourceReal, "bots");
  const mainRow = mapByOld.get(MAIN_BOT_ID);

  if (mainRow?.kind === "main") {
    const srcMain = Layout.mainBot(sourceReal);
    const dstMain = Layout.mainBot(targetDir);
    copyIfMissing(join(srcMain, "memory.md"), join(dstMain, "memory.md"), guard);
    copyIfMissing(join(srcMain, "routines.cron"), join(dstMain, "routines.cron"), guard);
  }

  const importedProjects: ProjectRecord[] = [];
  if (mainRow?.kind === "main-as-bot") {
    const ownDir = Layout.standalone(targetDir, mainRow.newId);
    guard(join(ownDir, ".bot"));
    mkdirSync(join(ownDir, ".bot"), { recursive: true });
    const srcMain = Layout.mainBot(sourceReal);
    copyIfMissing(join(srcMain, "memory.md"), join(ownDir, ".bot", "memory.md"), guard);
    copyIfMissing(join(srcMain, "routines.cron"), join(ownDir, ".bot", "routines.cron"), guard);
    importedProjects.push({
      id: mainRow.newId,
      name: mainRow.name,
      folder: pathToFileURL(ownDir + sep).toString(),
      avatar: "circle",
      job: "Imported main bot",
    });
  }

  for (const project of sourceProjects) {
    const mapped = mapByOld.get(project.id.toUpperCase());
    if (!mapped) continue;
    if (mapped.newId === mainId || mapped.newId === maintainerId) continue;

    let nextFolder = project.folder;
    let resolvedFolder: string | null = null;
    try {
      // The real spelling: 2.x stored the folder as it spelled its data folder (through a symlink, in another case),
      // which need not be `sourceReal`'s spelling. A folder inside the 2.x folder must be found whatever the spelling.
      resolvedFolder = realPathOrNearest(
        resolve(project.folder.startsWith("file:") ? fileURLToPath(project.folder) : project.folder),
      );
    } catch {
      resolvedFolder = null;
    }

    if (resolvedFolder && isInside(resolvedFolder, botsRoot) && resolvedFolder !== botsRoot) {
      const ownDir = Layout.standalone(targetDir, mapped.newId);
      copyTreeReadOnly(resolvedFolder, ownDir, sourceReal, guard);
      nextFolder = pathToFileURL(ownDir + sep).toString();
    } else if (resolvedFolder && resolvedFolder === sourceReal) {
      // A bot that worked in the 2.x data folder itself: never copy that folder (chats, settings, plugin-secrets.json).
      const ownDir = Layout.standalone(targetDir, mapped.newId);
      guard(ownDir);
      mkdirSync(ownDir, { recursive: true });
      nextFolder = pathToFileURL(ownDir + sep).toString();
      problems.push(`${project.name}: its folder was the Botling 2 data folder; it was not copied (the bot gets an empty folder)`);
    } else if (resolvedFolder && isInside(resolvedFolder, sourceReal)) {
      const remapped = remapApprovalPath(resolvedFolder, sourceReal, targetDir, idMap);
      copyTreeReadOnly(resolvedFolder, remapped, sourceReal, guard);
      nextFolder = pathToFileURL(remapped + sep).toString();
    }

    importedProjects.push({
      ...project,
      id: mapped.newId,
      folder: nextFolder,
    });
  }

  const existing = loadProjects(targetDir).projects;
  const existingIds = new Set(existing.map((p) => p.id.toUpperCase()));
  const merged = [...existing];
  for (const project of importedProjects) {
    if (!existingIds.has(project.id.toUpperCase())) {
      existingIds.add(project.id.toUpperCase());
      merged.push(project);
    }
  }
  guard(Layout.projectsFile(targetDir));
  mkdirSync(targetDir, { recursive: true });
  writeFileAtomic(Layout.projectsFile(targetDir), JSON.stringify(merged, null, 2));
}

function dryRunApprovalSummary(
  sourceReal: string,
  targetDir: string,
  read: ReturnType<typeof read2x>,
  idMap: readonly IdMapRow[],
  problems: string[],
): {
  folders: number;
  movedFolders: number;
  approvedCommandFolders: number;
  movedCommandFolders: number;
  alwaysAllowedCount: number;
} {
  const seenFolders = new Set<string>();
  let movedFolders = 0;
  for (const folder of read.folders) {
    const from = resolve(folder);
    const to = remapApprovalPath(from, sourceReal, targetDir, idMap);
    if (!seenFolders.has(to)) {
      seenFolders.add(to);
      if (to !== from) movedFolders += 1;
    }
  }

  const cmdFolders = new Set<string>();
  let movedCommandFolders = 0;
  if (read.approvedCommands && typeof read.approvedCommands === "object" && !Array.isArray(read.approvedCommands)) {
    for (const [folder, rawCommands] of Object.entries(read.approvedCommands as Record<string, unknown>)) {
      if (!isAbsolute(folder) || !Array.isArray(rawCommands)) continue;
      const valid = rawCommands.some((c) => typeof c === "string" && c.length > 0);
      if (!valid) continue;
      const from = resolve(folder);
      const to = remapApprovalPath(from, sourceReal, targetDir, idMap);
      if (!cmdFolders.has(to)) {
        cmdFolders.add(to);
        if (to !== from) movedCommandFolders += 1;
      }
    }
  }

  let alwaysAllowedCount = 0;
  for (const bot of read.bots) {
    if (existsSync(bot.chatDir)) {
      alwaysAllowedCount += readAlwaysAllowed(bot.chatDir, problems).length;
    }
  }

  return {
    folders: seenFolders.size,
    movedFolders,
    approvedCommandFolders: cmdFolders.size,
    movedCommandFolders,
    alwaysAllowedCount,
  };
}

export async function runImport(options: RunImportOptions): Promise<RunImportResult> {
  const dryRun = options.dryRun === true;
  const sourceResolved = resolve(options.sourceDir);
  const targetResolved = resolve(options.targetDir);

  refuse2xData(targetResolved);
  if (!looksLike2x(sourceResolved)) {
    throw new ImportError(`${sourceResolved} does not look like a Botling 2 data folder.`, 2);
  }

  // The OS spelling (case folded on a case-insensitive volume): it is also the source's identity (`sourceHash`).
  const sourceReal = realPath(sourceResolved);
  // Compare real paths and inodes: a symlinked or differently-cased spelling of either folder must not let the target
  // sit inside the 2.x folder.
  const targetReal = realPathOrNearest(targetResolved);
  if (sameOrNested(targetReal, sourceReal)) {
    throw new ImportError("The import's source and target must be separate folders.", 2);
  }
  const sourceHash = sha256Text(sourceReal);
  const metaKey = importSourceMetaKey(sourceHash);
  const reportPath = join(targetResolved, "import-report.md");

  if (holderPid(targetResolved) !== null) {
    throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  }

  const nowMs = options.now?.() ?? Date.now();
  const builtInsDir = options.builtInsDir !== undefined ? options.builtInsDir : defaultBuiltInsDir();

  if (dryRun) {
    let existingMainId: string | undefined;
    let existingMaintainerId: string | undefined;
    let existingLiveIds: Set<string> | undefined;
    let storedIdMap: ReturnType<typeof readIdMap> = [];

    const dbFile = join(targetResolved, "server.db");
    if (existsSync(dbFile)) {
      const reader = openReaderDb(dbFile);
      try {
        const prev = reader.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey);
        if (prev && typeof prev.value === "string") {
          throw new ImportError(`This folder was imported on ${parseImportedAt(prev.value)}. Nothing was changed.`, 2);
        }
        const mRow = reader.prepare("SELECT value FROM meta WHERE key = 'ids.main'").get();
        if (mRow && typeof mRow.value === "string") existingMainId = mRow.value;
        const mgRow = reader.prepare("SELECT value FROM meta WHERE key = 'ids.maintainer'").get();
        if (mgRow && typeof mgRow.value === "string") existingMaintainerId = mgRow.value;
        existingLiveIds = liveBotIds(reader);
        storedIdMap = readIdMap(reader, sourceHash);
      } finally {
        reader.close();
      }
    }

    const read = read2x(sourceReal);
    const loadedProjects = loadProjects(sourceReal);
    const problems = [...read.problems, ...(loadedProjects.problem ? [loadedProjects.problem] : [])];

    const mainId = options.mainId ?? existingMainId ?? MAIN_BOT_ID;
    const maintainerId = options.maintainerId ?? existingMaintainerId ?? MAINTAINER_ID;
    const designated = options.designated ?? true;
    const idMap =
      storedIdMap.length > 0
        ? reconstructIdMap(read.bots, storedIdMap)
        : mapIds(read.bots, { mainId, maintainerId, designated, existingIds: existingLiveIds });
    const mapByOld = new Map(idMap.map((r) => [r.oldId, r]));
    const bots = mappedBots(read.bots, mapByOld, problems);

    const botReports: ImportBotReportEntry[] = [];
    for (const bot of bots) {
      const mapped = mapByOld.get(bot.id)!;
      const dryBot = prepareDryRunBot(bot, mapped.newId);
      problems.push(...dryBot.problems);
      botReports.push({
        oldId: bot.id,
        newId: mapped.newId,
        kind: mapped.kind,
        name: mapped.name,
        ...(mapped.clash ? { clash: true } : {}),
        lines: dryBot.lines,
        skipped: dryBot.skipped,
        pins: dryBot.lists.pins,
        missingPinLines: dryBot.lists.missingPinLines,
        specs: dryBot.lists.specs,
        tasks: dryBot.lists.tasks,
        subagents: dryBot.lists.subagents,
        subagentSteps: dryBot.lists.subagentSteps,
      });
    }

    const approvals = dryRunApprovalSummary(sourceReal, targetResolved, read, idMap, problems);
    const mappedSettings = mapSettings(read.settings, new Map(idMap.map((r) => [r.oldId, r.newId])));

    const registry = new PluginRegistry(
      join(sourceReal, "plugins"),
      join(sourceReal, "plugins.json"),
      new MemorySecretStore(),
      builtInsDir,
    );
    const inputs = installedFromRegistry(registry.plugins, {
      author: "import",
      dataRoot: join(sourceReal, "plugin-data"),
      log: options.log,
    });
    const pluginEntries: PluginReportDryRunEntry[] = inputs
      .filter((item) => item.name.length <= 64 && RowKey.safeParse(`plugin:${item.name}`).success)
      .map((item) => ({
        name: item.name,
        author: item.author,
        ask: item.manifest.tier,
        granted: (item.author === "builtin" ? "write" : "read") as PluginReportDryRunEntry["granted"],
      }))
      .sort((a, b) => {
        const aBuiltIn = a.author === "builtin" ? 0 : 1;
        const bBuiltIn = b.author === "builtin" ? 0 : 1;
        if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

    const totalLines = botReports.reduce((sum, b) => sum + b.lines, 0);
    const totalSkipped = botReports.reduce((sum, b) => sum + b.skipped, 0);
    const totalPins = botReports.reduce((sum, b) => sum + b.pins, 0);
    const totalMissingPinLines = botReports.reduce((sum, b) => sum + b.missingPinLines, 0);

    const reportText = formatImportReport({
      dryRun: true,
      reportPath,
      bots: botReports,
      totalLines,
      totalSkipped,
      totalPins,
      totalMissingPinLines,
      idMap,
      settings: {
        movedPrefs: mappedSettings.prefs.map((p) => p.key),
        machineKeys: Object.keys(mappedSettings.machine).sort(),
        layoutKeys: [...mappedSettings.layoutKeys].sort(),
        oversizedKeys: [...mappedSettings.oversizedKeys].sort(),
      },
      approvals,
      plugins: pluginEntries,
      hasSecrets: read.hasSecrets,
      problems,
    });

    return {
      dryRun: true,
      sourceRealPath: sourceReal,
      sourceHash,
      reportPath,
      reportText,
      bots: botReports,
      totalLines,
      totalSkipped,
      totalPins,
      problems,
    };
  }

  // Non-dry-run: nothing may lead into the 2.x folder (a link in botlingd's folder included), then hold the lock.
  const guard = makeWriteGuard(sourceReal);
  guardTargetTop(targetResolved, guard);
  mkdirSync(targetResolved, { recursive: true, mode: 0o700 });
  const lock = new DataDirLock(targetResolved, { version: BOTLINGD_VERSION, app: "botlingd import" });
  const claim = lock.claim();
  if (!claim.ok) {
    throw new ImportError("botlingd is running; stop it first (botlingd stop).", CORE_EXIT_DATA_DIR_IN_USE);
  }

  try {
    const store = await openServerStore(targetResolved);
    try {
      const existingImport = store.meta(metaKey);
      if (existingImport !== undefined) {
        throw new ImportError(`This folder was imported on ${parseImportedAt(existingImport)}. Nothing was changed.`, 2);
      }

      const identity = await loadOrCreateServerIdentity(targetResolved, {
        create: store.meta("memberId") === undefined,
      });
      const { memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));

      // 1. Reader
      const read = read2x(sourceReal);
      const loadedProjects = loadProjects(sourceReal);
      const problems = [...read.problems, ...(loadedProjects.problem ? [loadedProjects.problem] : [])];

      // 2. Id map (reused on resume if already saved for this source)
      const mainId = options.mainId ?? store.meta("ids.main") ?? MAIN_BOT_ID;
      const maintainerId = options.maintainerId ?? store.meta("ids.maintainer") ?? MAINTAINER_ID;
      const designated = options.designated ?? true;

      let storedIdMap: ReturnType<typeof readIdMap>;
      let existingIds: Set<string>;
      {
        const reader = store.openReader();
        try {
          storedIdMap = readIdMap(reader, sourceHash);
          existingIds = liveBotIds(reader);
        } finally {
          reader.close();
        }
      }

      let idMap: IdMapRow[];
      if (storedIdMap.length > 0) {
        idMap = reconstructIdMap(read.bots, storedIdMap);
      } else {
        idMap = mapIds(read.bots, { mainId, maintainerId, designated, existingIds });
        await store.submit((tx) => saveIdMap(tx, sourceHash, idMap));
      }
      const mapByOld = new Map(idMap.map((r) => [r.oldId, r]));
      const bots = mappedBots(read.bots, mapByOld, problems);

      // 3 & 4. Chats + Lists per bot (via DbBotStores)
      const botReports: ImportBotReportEntry[] = [];
      const stores = new DbBotStores(store);
      try {
        for (let i = 0; i < bots.length; i++) {
          const bot = bots[i]!;
          const mapped = mapByOld.get(bot.id)!;
          const result = await importBotChat(store, stores, bot, mapped, {
            source: sourceHash,
            now: options.now,
            log: options.log,
            onBatch: options.onBatch,
          });
          await stores.durable();

          let lines = result.lines;
          let lists = result.lists;
          let skipped = result.skipped;
          if (result.alreadyDone) {
            const reader = store.openReader();
            try {
              const existing = readExistingBotCounts(reader, mapped.newId);
              lines = existing.lines;
              lists = existing.lists;
            } finally {
              reader.close();
            }
            // Done in an earlier run: recount (read only) what that run skipped, with the same rule the import used.
            const again = prepareDryRunBot(bot, mapped.newId);
            skipped = again.skipped;
            lists = { ...lists, missingPinLines: again.lists.missingPinLines };
          }

          problems.push(...result.problems, ...lists.problems);
          botReports.push({
            oldId: bot.id,
            newId: mapped.newId,
            kind: mapped.kind,
            name: mapped.name,
            ...(mapped.clash ? { clash: true } : {}),
            lines,
            skipped,
            pins: lists.pins,
            missingPinLines: lists.missingPinLines,
            specs: lists.specs,
            tasks: lists.tasks,
            subagents: lists.subagents,
            subagentSteps: lists.subagentSteps,
          });

          options.onBotDone?.({
            oldId: bot.id,
            newId: mapped.newId,
            index: i,
            total: bots.length,
          });
        }
      } finally {
        await stores.durable().catch(() => undefined);
        await stores.close();
      }

      writeImportedWorkspaceFiles(
        sourceReal,
        targetResolved,
        loadedProjects.projects,
        idMap,
        mainId,
        maintainerId,
        problems,
        guard,
      );

      // 5. Approvals
      const botApprovalRefs: BotApprovalRef[] = bots.map((bot) => {
        const mapped = mapByOld.get(bot.id)!;
        return {
          oldId: bot.id,
          newId: mapped.newId,
          name: mapped.name,
          chatDir: bot.chatDir,
        };
      });
      guard(join(targetResolved, "folders.json"));
      guard(join(targetResolved, "approved-commands.json"));
      let approvalReport;
      {
        const reader = store.openReader();
        try {
          approvalReport = importApprovals({
            sourceDir: sourceReal,
            targetDir: targetResolved,
            idMap,
            db: reader,
            bots: botApprovalRefs,
          });
        } finally {
          reader.close();
        }
      }
      problems.push(...approvalReport.problems);

      // 6. Settings -> PrefsStore (cluster prefs) + settings.json (machine-local settings)
      const mappedSettings = mapSettings(read.settings, new Map(idMap.map((r) => [r.oldId, r.newId])));
      const prefsStore = await PrefsStore.open(store, { self: memberId, log: options.log });
      for (const pref of mappedSettings.prefs) {
        const current = prefsStore.get(pref.key);
        if (!current || canonicalJson(current.value) !== canonicalJson(pref.value)) {
          await prefsStore.set(pref.key, pref.value);
        }
      }
      const existingSettings: RawSettings = readSettings(Layout.settings(targetResolved));
      const mergedMachine: RawSettings = { ...mappedSettings.machine, ...existingSettings };
      guard(Layout.settings(targetResolved));
      writeSettings(Layout.settings(targetResolved), mergedMachine);

      // 7. Plugins + 8. Tiers
      guard(join(targetResolved, "plugins.json"));
      const secrets = secretsNode(sourceReal);
      const pluginResult = importPlugins(sourceReal, targetResolved, {
        builtInsDir,
        guardWrite: guard,
        skipSourceFile: (stat) => sameNode(stat, secrets),
      });
      problems.push(...pluginResult.problems);
      for (const mismatch of pluginResult.hashMismatches) {
        problems.push(`plugin ${mismatch.name}: folderHash mismatch (${mismatch.sourceHash} != ${mismatch.targetHash})`);
      }

      const registry = new PluginRegistry(
        join(targetResolved, "plugins"),
        join(targetResolved, "plugins.json"),
        new MemorySecretStore(),
        builtInsDir,
      );
      const pluginInputs = installedFromRegistry(registry.plugins, {
        author: "import",
        dataRoot: join(targetResolved, "plugin-data"),
        log: options.log,
      });
      await store.submit((tx) => reconcilePluginRows(tx, ownTableStream(tx), pluginInputs, nowMs, { log: options.log }));

      let pluginEntries: PluginReportEntry[];
      {
        const reader = store.openReader();
        try {
          pluginEntries = readPluginReportEntries(reader);
        } finally {
          reader.close();
        }
      }

      // 9 & 10. Media/Secrets (M6-05/M6-06 placeholders until merged) + Report + final meta mark
      const totalLines = botReports.reduce((sum, b) => sum + b.lines, 0);
      const totalSkipped = botReports.reduce((sum, b) => sum + b.skipped, 0);
      const totalPins = botReports.reduce((sum, b) => sum + b.pins, 0);
      const totalMissingPinLines = botReports.reduce((sum, b) => sum + b.missingPinLines, 0);

      const reportText = formatImportReport({
        dryRun: false,
        reportPath,
        bots: botReports,
        totalLines,
        totalSkipped,
        totalPins,
        totalMissingPinLines,
        idMap,
        settings: {
          movedPrefs: mappedSettings.prefs.map((p) => p.key),
          machineKeys: Object.keys(mappedSettings.machine).sort(),
          layoutKeys: [...mappedSettings.layoutKeys].sort(),
          oversizedKeys: [...mappedSettings.oversizedKeys].sort(),
        },
        approvals: {
          folders: approvalReport.folders.length,
          movedFolders: approvalReport.movedFolders.length,
          approvedCommandFolders: Object.keys(approvalReport.approvedCommands).length,
          movedCommandFolders: approvalReport.movedCommandFolders.length,
          alwaysAllowedCount: approvalReport.alwaysAllowedCount,
        },
        plugins: pluginEntries,
        hasSecrets: read.hasSecrets,
        problems,
      });

      const reportHash = sha256Text(reportText);
      const metaValue = JSON.stringify({
        at: new Date(nowMs).toISOString(),
        sourceName: basename(sourceReal),
        reportHash,
      });
      // The report file first: if it cannot be written the meta mark stays unset and a second run can redo it.
      guard(reportPath);
      writeFileAtomic(reportPath, reportText);
      await store.submit((tx) => {
        tx.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        ).run(metaKey, metaValue);
      });

      return {
        dryRun: false,
        sourceRealPath: sourceReal,
        sourceHash,
        reportPath,
        reportText,
        bots: botReports,
        totalLines,
        totalSkipped,
        totalPins,
        problems,
      };
    } finally {
      await store.close();
    }
  } finally {
    lock.release();
  }
}
