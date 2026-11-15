// 2.x -> 3.x import: the preparation steps (counts, dry-run preview, id-map rebuild, workspace files, approval summary).
// Moved out of run.ts (M7-S21b); `runImport` there calls them.
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { messageView } from "../../core/bot";
import { writeFileAtomic } from "../../core/durable/atomic";
import { MAIN_BOT_ID, type ProjectRecord } from "../../core/store/records";
import { Layout, loadProjects } from "../../core/store/workspace";
import { fitBody } from "../effects/fit";
import type { Db } from "../store";
import { readAlwaysAllowed, remapApprovalPath } from "./approvals";
import type { ImportedBotLists } from "./chats";
import type { IdMapRow } from "./id-map";
import { copyIfMissing, copyTreeReadOnly, isInside, realPathOrNearest, type WriteGuard } from "./fs-safe";
import { read2x, readChat, type Read2xBot } from "./reader-2x";

function countListItems(rawBody: unknown): number {
  if (typeof rawBody !== "string") return 0;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function readExistingBotCounts(db: Db, botId: string): { lines: number; lists: ImportedBotLists } {
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

export function prepareDryRunBot(bot: Read2xBot, newId: string): {
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
export function mappedBots(bots: readonly Read2xBot[], mapByOld: ReadonlyMap<string, IdMapRow>, problems: string[]): Read2xBot[] {
  return bots.filter((bot) => {
    if (mapByOld.has(bot.id)) return true;
    problems.push(`${bot.name} (${bot.id}): added to Botling 2 after this import started; not imported`);
    return false;
  });
}

export function reconstructIdMap(
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

export function writeImportedWorkspaceFiles(
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

export function dryRunApprovalSummary(
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
