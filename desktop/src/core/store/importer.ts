// The first-launch import from a Botling 1.x data folder (`~/.claudecodebot`). It only reads the
// source: files are opened for reading and their contents written into 2.0's own folder. Nothing
// in the source is created, renamed, locked, touched or deleted, so 1.x keeps working as before.
//
// What comes over (2.0 keeps 1.x's formats, so this is mostly a checked copy):
// - the main bot's chat files (chat.json, bot.json, subagents.json, tasks.json, pins.json,
//   specs.json) and its notes (memory.md, routines.cron);
// - projects.json, and each project's and bot's chat files;
// - a bot of its own's notes (.bot/memory.md, inbox.md, routines.cron), into 2.0's bots/<ID>/,
//   with its folder in projects.json pointed there;
// - settings.json;
// - the plugin library's components (`plugins/<plugin>/components/<name>/`: template.html, about.md
//   and the other text files beside them), into 2.0's own plugins folder, where its library reads them.
// What stays where it is: a project manager's working folder (the user's project, with its
// .bot/memory.md — 2.0 works in the same folder, like 1.x), attachments, chat archives, result
// pages and screenshots (messages keep pointing at them, read-only), Maintainer and the rest of the
// plugin library (its git history, its plugins' code), web AIs' folders, the commands 1.x was
// allowed to run (2.0 asks again), and claude's own sessions (2.0 starts new ones).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "../durable/atomic";
import { CHAT_FILES } from "./bot-store";
import { Layout } from "./workspace";
import { MAINTAINER_ID, isChatRecord, isProjectRecord, type ProjectRecord } from "./records";

export interface ImportReport {
  source: string;
  at: string;
  bots: { id: string; name: string; messages: number }[];
  messages: number;
  skipped: string[];
  /** Components imported from the plugin library. */
  components?: number;
}

/** What a component folder may bring along: its template, usage and the scripts or styles beside them. */
const TEXT_FILE = /\.(html?|md|js|mjs|cjs|css|json|txt|sh|py|rb|ts|svg|csv|ya?ml|toml)$/i;

function safeList(dir: string): string[] {
  try { return readdirSync(dir).sort(); } catch { return []; }
}

const MAX_FILE = 50 * 1024 * 1024;
const NOTES_MAIN = ["memory.md", "routines.cron"];
const NOTES_BOT = [".bot/memory.md", ".bot/inbox.md", ".bot/routines.cron"];

const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

/** Whether `root` is a fresh 2.0 data folder (nothing to lose by importing into it). */
export function needsImport(root: string): boolean {
  return !existsSync(Layout.importRecord(root)) && !existsSync(Layout.projectsFile(root)) && !existsSync(join(Layout.mainBot(root), "chat.json"));
}

/** Whether `source` looks like a 1.x data folder. */
export function looksLike1x(source: string): boolean {
  return existsSync(join(source, "main")) || existsSync(join(source, "projects.json"));
}

export function importRecord(root: string): ImportReport | null {
  try {
    return JSON.parse(readFileSync(Layout.importRecord(root), "utf8")) as ImportReport;
  } catch {
    return null;
  }
}

/** Imports `sourceDir` (a 1.x data folder) into `targetDir` (2.0's). Reads the source only. */
export function importFrom1x(sourceDir: string, targetDir: string): ImportReport {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (inside(target, source) || inside(source, target)) throw new Error("The import's source and target must be separate folders.");
  if (!looksLike1x(source)) throw new Error(`${source} does not look like a Botling 1.x data folder.`);
  const report: ImportReport = { source, at: new Date().toISOString(), bots: [], messages: 0, skipped: [] };

  /** Reads a source file (only reads), or null with a note when it is missing, too big or unreadable. */
  const read = (file: string): Buffer | null => {
    if (!existsSync(file)) return null;
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE) {
      report.skipped.push(`${file}: larger than ${MAX_FILE / 1024 / 1024} MB`);
      return null;
    }
    try {
      return readFileSync(file);
    } catch (error) {
      report.skipped.push(`${file}: could not be read (${(error as Error).message})`);
      return null;
    }
  };
  const write = (file: string, data: Buffer | string) => {
    if (!inside(file, target)) throw new Error(`refusing to write outside the target: ${file}`);
    writeFileAtomic(file, typeof data === "string" ? data : data.toString("utf8"));
  };

  /** Copies a bot's chat files; returns how many chat lines it has (null: chat skipped). */
  const copyChat = (from: string, to: string): number => {
    let count = 0;
    for (const name of [...CHAT_FILES, "bot.json"]) {
      const data = read(join(from, name));
      if (!data) continue;
      let value: unknown;
      try {
        value = JSON.parse(data.toString("utf8"));
      } catch {
        report.skipped.push(`${join(from, name)}: not valid JSON, left out`);
        continue;
      }
      if (name === "chat.json") {
        if (!Array.isArray(value)) {
          report.skipped.push(`${join(from, name)}: not a list of chat lines, left out`);
          continue;
        }
        const good = value.filter(isChatRecord).length;
        if (good < value.length) report.skipped.push(`${join(from, name)}: ${value.length - good} line(s) 1.x itself would not read`);
        count = good;
      }
      write(join(to, name), data);
    }
    return count;
  };
  const copyNotes = (fromFolder: string, toFolder: string, names: string[]) => {
    for (const name of names) {
      const data = read(join(fromFolder, name));
      if (data) write(join(toFolder, name), data);
    }
  };

  // The main bot: its chat and its notes (its home is its working folder).
  const mainFrom = join(source, "main");
  if (existsSync(mainFrom)) {
    const messages = copyChat(mainFrom, Layout.mainBot(target));
    copyNotes(mainFrom, Layout.mainBot(target), NOTES_MAIN);
    report.bots.push({ id: "main", name: "Main bot", messages });
    report.messages += messages;
  }

  // Projects and bots of their own.
  const projectsData = read(Layout.projectsFile(source));
  const projects: ProjectRecord[] = [];
  if (projectsData) {
    let rows: unknown = null;
    try {
      rows = JSON.parse(projectsData.toString("utf8"));
    } catch {
      report.skipped.push(`${Layout.projectsFile(source)}: not valid JSON; no projects imported`);
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isProjectRecord(row)) {
        report.skipped.push(`a projects.json row that is not a project: ${JSON.stringify(row).slice(0, 120)}`);
        continue;
      }
      if (row.id === MAINTAINER_ID) continue; // Never saved there by 1.x; Maintainer is not ported.
      const project: ProjectRecord = { ...row };
      // A bot of its own lives in the 1.x folder: its notes come over, and it works in 2.0's.
      let folder: string | null = null;
      try {
        folder = row.folder.startsWith("file:") ? fileURLToPath(row.folder) : row.folder;
      } catch { /* kept as it is */ }
      if (folder && inside(resolve(folder), join(source, "bots"))) {
        const own = Layout.standalone(target, row.id);
        copyNotes(folder, own, NOTES_BOT);
        project.folder = pathToFileURL(own + sep).toString();
      }
      const messages = copyChat(Layout.bot(source, row.id), Layout.bot(target, row.id));
      projects.push(project);
      report.bots.push({ id: row.id, name: row.name, messages });
      report.messages += messages;
    }
  }
  if (hasMaintainerChat(source)) report.skipped.push("Maintainer's chat (Maintainer and the plugin library are not in 2.0 yet)");

  const settings = read(Layout.settings(source));
  if (settings) {
    try {
      JSON.parse(settings.toString("utf8"));
      write(Layout.settings(target), settings);
    } catch {
      report.skipped.push(`${Layout.settings(source)}: not valid JSON, left out`);
    }
  }
  // The component library: each plugin's components/ folder, text files only.
  const plugins = join(source, "plugins");
  let components = 0;
  if (existsSync(plugins)) {
    for (const plugin of safeList(plugins)) {
      const folder = join(plugins, plugin, "components");
      if (plugin.startsWith(".") || !existsSync(folder)) continue;
      for (const name of safeList(folder)) {
        const from = join(folder, name);
        if (name.startsWith(".") || !existsSync(join(from, "template.html"))) continue;
        for (const file of listFiles(from).filter((path) => !path.split(sep).some((part) => part.startsWith(".")))) {
          if (!TEXT_FILE.test(file)) { report.skipped.push(`${join(from, file)}: not a text file, left out`); continue; }
          const data = read(join(from, file));
          if (data) write(join(target, "plugins", plugin, "components", name, file), data);
        }
        components++;
      }
    }
    report.skipped.push("plugins/ (only the components were imported; plugins themselves are not in 2.0 yet)");
  }
  report.components = components;
  for (const folder of ["web", "runs", "teams"]) {
    if (existsSync(join(source, folder))) report.skipped.push(`${folder}/ (not used by 2.0 yet)`);
  }

  write(Layout.projectsFile(target), JSON.stringify(projects));
  // Last: its presence means the import finished.
  write(Layout.importRecord(target), JSON.stringify(report, null, 2));
  return report;
}

function hasMaintainerChat(source: string): boolean {
  return existsSync(join(Layout.bot(source, MAINTAINER_ID), "chat.json"));
}

/** Every file under a folder (relative paths), for tests that check the source is untouched. */
export function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}
