// The first-launch import from a Botling 1.x data folder (`~/.claudecodebot`). It only reads the
// source: files are opened for reading and their contents written into 2.0's own folder. Nothing
// in the source is created, renamed, locked, touched or deleted, so 1.x keeps working as before.
//
// What comes over (2.0 keeps 1.x's formats, so this is mostly a checked copy):
// - the main bot's chat files (chat.json, bot.json, subagents.json, tasks.json, pins.json,
//   specs.json) and its notes (memory.md, routines.cron);
// - projects.json, and each project's and bot's chat files, and Maintainer's;
// - a bot of its own's notes (.bot/memory.md, inbox.md, routines.cron), into 2.0's bots/<ID>/,
//   with its folder in projects.json pointed there;
// - settings.json and the three local usage records (spending and each CLI's limits);
// - what the user allowed in 1.x: folders.json (folders Maintainer may read), approved-commands.json
//   (component commands, by folder: a folder inside the 1.x data folder — the main bot's, a bot of
//   its own's — is moved to the same place in 2.0's), and each bot's "always allow" tools and rules
//   (bot.json's alwaysAllowed, with the chat files);
// - the web AIs' saved conversations (`web/<site>/`: conversations.json and each conversation's .md);
// - the plugin library (`plugins/`): every plugin's text files (manifests, bundled code, components,
//   Claude parts) and Maintainer's notes (.bot/memory.md), into 2.0's own plugins folder; and
//   plugins.json (which plugins are off, their settings, where outside ones came from) without any
//   setting a plugin declares secret. Secrets themselves are in 1.x's keychain: never read, never copied.
// What stays where it is: a project manager's working folder (the user's project, with its
// .bot/memory.md — 2.0 works in the same folder, like 1.x), attachments, chat archives, result
// pages and screenshots (messages keep pointing at them, read-only), the library's git history,
// node_modules and binary files (pictures, fonts), web AIs' sign-ins (1.x's WebKit stores), and claude's
// own sessions: as 1.x does after its own restart, each bot starts a new session and wakes from its
// memory (a 1.x session id is never kept: the main bot works in another folder here, where claude
// cannot find that session, and 2.0, like 1.x, never resumes a session across app starts).
import { readLimits, readSpending } from "../usage";
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
  /** Plugins (folders with a package.json) imported from the plugin library. */
  plugins?: number;
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
      if (row.id === MAINTAINER_ID) continue; // Never saved there by 1.x; Maintainer is the app's own (below).
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
  // Maintainer: its chat; its notes are in the plugin library (below).
  if (hasMaintainerChat(source)) {
    const messages = copyChat(Layout.bot(source, MAINTAINER_ID), Layout.bot(target, MAINTAINER_ID));
    report.bots.push({ id: MAINTAINER_ID, name: "Maintainer", messages });
    report.messages += messages;
  }

  // Group chats (Phase 4c): groups.json and each group's chat files (groups/<ID>/), as 1.x keeps them.
  const groupsFile = read(join(source, "groups.json"));
  if (groupsFile) {
    let groups: unknown;
    try { groups = JSON.parse(groupsFile.toString("utf8")); } catch { groups = null; }
    if (Array.isArray(groups)) {
      write(join(target, "groups.json"), groupsFile);
      for (const group of groups) {
        const id = (group as { id?: unknown })?.id;
        if (typeof id !== "string" || !/^[0-9A-Fa-f-]{36}$/.test(id)) continue;
        const messages = copyChat(join(source, "groups", id), join(target, "groups", id.toUpperCase()));
        report.messages += messages;
      }
    } else {
      report.skipped.push(`${join(source, "groups.json")}: not a list of groups, left out`);
    }
  }

  const settings = read(Layout.settings(source));
  if (settings) {
    try {
      JSON.parse(settings.toString("utf8"));
      write(Layout.settings(target), settings);
    } catch {
      report.skipped.push(`${Layout.settings(source)}: not valid JSON, left out`);
    }
  }
  // What the user allowed: folders Maintainer may read, and component commands by folder.
  const folders = read(join(source, "folders.json"));
  if (folders) {
    try {
      const value = JSON.parse(folders.toString("utf8"));
      if (!Array.isArray(value)) throw new Error("not a list");
      write(join(target, "folders.json"), JSON.stringify(value.filter((path): path is string => typeof path === "string" && isAbsolute(path))));
    } catch {
      report.skipped.push(`${join(source, "folders.json")}: not a list of folders, left out`);
    }
  }
  const approved = read(join(source, "approved-commands.json"));
  if (approved) {
    try {
      const value = JSON.parse(approved.toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a map");
      const kept: Record<string, string[]> = {};
      for (const [folder, commands] of Object.entries(value as Record<string, unknown>)) {
        if (!isAbsolute(folder) || !Array.isArray(commands)) continue;
        const from = resolve(folder);
        const to = inside(from, source) ? join(target, relative(source, from)) : from;
        const list = commands.filter((command): command is string => typeof command === "string" && command.length > 0);
        kept[to] = [...new Set([...(kept[to] ?? []), ...list])].sort();
      }
      write(join(target, "approved-commands.json"), JSON.stringify(Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b))), null, 2));
    } catch {
      report.skipped.push(`${join(source, "approved-commands.json")}: not valid approved commands, left out`);
    }
  }
  // Only the existing accounting files: no CLI logs, sessions or credentials. Import never
  // reads these again after first launch, so 2.x's own recorded totals are not overwritten.
  for (const name of ["spending.json", "rate-limits.json", "codex-rate-limits.json"]) {
    const data = read(join(source, name));
    if (!data) continue;
    try {
      const value = JSON.parse(data.toString("utf8"));
      const record = name === "spending.json" ? readSpending(value) : readLimits(value);
      const valid = name === "spending.json" ? record !== null
        : value && typeof value === "object" && !Array.isArray(value) && (Object.keys(value).length === 0 || Object.keys(record!).length > 0);
      if (!valid) throw new Error("invalid usage record");
      // Keep just usage fields, never arbitrary extra fields attached to these JSON files.
      write(join(target, name), JSON.stringify(record));
    } catch {
      report.skipped.push(`${join(source, name)}: not a valid usage record, left out`);
    }
  }
  // The plugin library: every plugin's text files (its components among them), and Maintainer's notes.
  const plugins = join(source, "plugins");
  let components = 0;
  let pluginCount = 0;
  if (existsSync(plugins)) {
    copyNotes(plugins, join(target, "plugins"), [".bot/memory.md", ".bot/inbox.md", ".bot/routines.cron"]);
    for (const plugin of safeList(plugins)) {
      const folder = join(plugins, plugin);
      if (plugin.startsWith(".") || !statSync(folder).isDirectory()) continue;
      const files = listFiles(folder).filter((path) => !path.split(sep).some((part) => part.startsWith(".") && part !== ".claude-plugin" && part !== ".mcp.json") && !path.split(sep).includes("node_modules"));
      for (const file of files) {
        if (!TEXT_FILE.test(file)) { report.skipped.push(`${join(folder, file)}: not a text file, left out`); continue; }
        const data = read(join(folder, file));
        if (data) write(join(target, "plugins", plugin, file), data);
      }
      if (existsSync(join(folder, "package.json"))) pluginCount++;
      for (const name of safeList(join(folder, "components"))) if (!name.startsWith(".") && existsSync(join(folder, "components", name, "template.html"))) components++;
    }
    if (existsSync(join(plugins, ".git"))) report.skipped.push("plugins/.git (the library's version history stays in 1.x; 2.0 starts its own)");
  }
  report.plugins = pluginCount;
  // Which plugins are off, their settings (never a secret one) and where outside ones came from.
  const state = read(join(source, "plugins.json"));
  if (state) {
    try {
      const value = JSON.parse(state.toString("utf8")) as Record<string, unknown>;
      const secretKeys = (plugin: string): Set<string> => {
        try {
          const manifest = JSON.parse(readFileSync(join(target, "plugins", plugin, "package.json"), "utf8")) as { ccb?: { contributes?: { settings?: Record<string, { secret?: boolean }> } } };
          return new Set(Object.entries(manifest.ccb?.contributes?.settings ?? {}).filter(([, setting]) => setting?.secret === true).map(([key]) => key));
        } catch { return new Set(); }
      };
      const settings: Record<string, Record<string, unknown>> = {};
      for (const [plugin, values] of Object.entries((value.settings ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!values || typeof values !== "object") continue;
        const secret = secretKeys(plugin);
        settings[plugin] = Object.fromEntries(Object.entries(values).filter(([key]) => !secret.has(key)));
      }
      const kept = {
        disabled: Array.isArray(value.disabled) ? value.disabled.filter((name) => typeof name === "string") : [],
        settings,
        failures: {},
        installed: value.installed && typeof value.installed === "object" ? value.installed : {},
      };
      write(join(target, "plugins.json"), JSON.stringify(kept, null, 2));
    } catch {
      report.skipped.push(`${join(source, "plugins.json")}: not valid JSON, left out`);
    }
  }
  if (pluginCount) report.skipped.push("plugins' secret settings (1.x keeps them in its keychain): enter them again under Plugins");
  // Whether the component editor's file is the app's own text (so 2.0 may update it).
  const editorRecord = read(join(source, "component-editor.json"));
  if (editorRecord) write(join(target, "component-editor.json"), editorRecord);
  report.components = components;
  // The web AIs' saved conversations: each site's list and its Markdown files (sign-ins stay in 1.x's WebKit stores).
  let webFiles = 0;
  for (const site of safeList(join(source, "web"))) {
    const folder = join(source, "web", site);
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(site) || !statSync(folder).isDirectory()) continue;
    for (const name of safeList(folder)) {
      if (name !== "conversations.json" && !/^[^./][^/]*\.md$/.test(name)) continue;
      const data = read(join(folder, name));
      if (data) { write(join(target, "web", site, name), data); webFiles++; }
    }
  }
  if (webFiles) report.skipped.push("web AIs' sign-ins (sign in again in each site; their saved conversations came over)");
  // Past teams' folders stay in 1.x; the teams themselves are the ccb-teams plugin's agents (imported above).
  if (existsSync(join(source, "runs"))) report.skipped.push("runs/ (past temporary teams' folders; they stay in 1.x)");
  if (existsSync(join(source, "teams"))) report.skipped.push("teams/ (1.x's old team files; the teams are the ccb-teams plugin's)");

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
