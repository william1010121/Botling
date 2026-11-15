import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawSettings } from "../../core/settings";
import { readJSON, type ChatFile } from "../../core/store/bot-store";
import { readLegacyRows } from "../../core/store/legacy-history";
import { isChatRecord, isProjectRecord, MAIN_BOT_ID, MAINTAINER_ID, type ChatRecord, type StepRecord } from "../../core/store/records";
import { foldLines, INDEX_FORMAT, indexEntry, READ_TAIL_BYTES, subagentFileName, type RunMeta, type SubagentHistory } from "../../core/store/subagent-store";
import { Layout } from "../../core/store/workspace";

export interface Read2xBot {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  folder: string;
  chatDir: string;
  standalone: boolean;
}

export interface Read2xPluginDir {
  name: string;
  dir: string;
}

export interface Read2x {
  bots: Read2xBot[];
  settings: RawSettings;
  pluginsState: unknown;
  pluginDirs: Read2xPluginDir[];
  hasSecrets: boolean;
  folders: string[];
  approvedCommands: unknown;
  problems: string[];
}

export interface Read2xSubagent {
  index: Record<string, unknown>;
  history: SubagentHistory;
}

export interface Read2xChat {
  chat: ChatRecord[];
  pins: unknown[];
  specs: unknown[];
  tasks: unknown[];
  subagents: Read2xSubagent[];
  settings: Record<string, unknown>;
  problems: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether `dir` looks like a Botling 2.x data folder (has 2.x layout files/folders and no `server.db`).
 * Strictly read-only.
 */
export function looksLike2x(dir: string): boolean {
  if (!existsSync(dir) || existsSync(join(dir, "server.db"))) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return (
    names.includes("projects.json")
    || names.includes("projects")
    || names.includes("settings.json")
    || names.includes("main")
  );
}

/** Reads a 2.x data folder's workspace metadata, strictly read-only. */
export function read2x(dir: string): Read2x {
  const root = resolve(dir);
  if (!looksLike2x(root)) {
    throw new Error(`${root} does not look like a Botling 2.x data folder.`);
  }

  const problems: string[] = [];
  const bots: Read2xBot[] = [
    {
      id: MAIN_BOT_ID,
      name: "Main bot",
      role: "main",
      folder: Layout.mainBot(root),
      chatDir: Layout.mainBot(root),
      standalone: false,
    },
    {
      id: MAINTAINER_ID,
      name: "Maintainer",
      role: "manager",
      folder: join(root, "plugins"),
      chatDir: Layout.bot(root, MAINTAINER_ID),
      standalone: false,
    },
  ];

  // Projects and standalone bots from projects.json
  const botsRoot = join(root, "bots");
  try {
    const rawProjects = readJSON(Layout.projectsFile(root));
    if (rawProjects !== undefined) {
      if (!Array.isArray(rawProjects)) {
        problems.push("projects.json: not a list");
      } else {
        for (const entry of rawProjects) {
          if (!isProjectRecord(entry)) {
            problems.push("projects.json: skipped invalid project record");
            continue;
          }
          if (entry.id === MAIN_BOT_ID || entry.id === MAINTAINER_ID) continue;
          let resolvedFolder: string | null = null;
          try {
            resolvedFolder = resolve(entry.folder.startsWith("file:") ? fileURLToPath(entry.folder) : entry.folder);
          } catch (error) {
            problems.push(`projects.json (${entry.id}): invalid folder path (${errorText(error)})`);
          }
          const role = typeof entry.job === "string" ? "bot" : "manager";
          const standalone = resolvedFolder !== null && isInside(resolvedFolder, botsRoot) && resolvedFolder !== botsRoot;
          bots.push({
            id: entry.id,
            name: entry.name,
            role,
            folder: resolvedFolder ?? entry.folder,
            chatDir: Layout.bot(root, entry.id),
            standalone,
          });
        }
      }
    }
  } catch (error) {
    problems.push(`projects.json: ${errorText(error)}`);
  }

  // settings.json
  let settings: RawSettings = {};
  try {
    const rawSettings = readJSON(Layout.settings(root));
    if (rawSettings !== undefined) {
      if (!isPlainObject(rawSettings)) {
        problems.push("settings.json: not an object");
      } else {
        settings = rawSettings;
      }
    }
  } catch (error) {
    problems.push(`settings.json: ${errorText(error)}`);
  }

  // plugins.json
  let pluginsState: unknown = null;
  try {
    const rawPlugins = readJSON(join(root, "plugins.json"));
    if (rawPlugins !== undefined) {
      if (!isPlainObject(rawPlugins)) {
        problems.push("plugins.json: not an object");
      } else {
        pluginsState = rawPlugins;
      }
    }
  } catch (error) {
    problems.push(`plugins.json: ${errorText(error)}`);
  }

  // plugins/<name>/
  const pluginDirs: Read2xPluginDir[] = [];
  const pluginsRoot = join(root, "plugins");
  try {
    if (existsSync(pluginsRoot) && statSync(pluginsRoot).isDirectory()) {
      for (const name of readdirSync(pluginsRoot).filter((item) => !item.startsWith(".")).sort()) {
        const pluginDir = join(pluginsRoot, name);
        try {
          if (statSync(pluginDir).isDirectory() && existsSync(join(pluginDir, "package.json"))) {
            pluginDirs.push({ name, dir: pluginDir });
          }
        } catch {
          // ignore unreadable entry
        }
      }
    }
  } catch (error) {
    problems.push(`plugins/: ${errorText(error)}`);
  }

  // plugin-secrets.json (existence & non-empty check only, never decrypted)
  let hasSecrets = false;
  try {
    const rawSecrets = readJSON(join(root, "plugin-secrets.json"));
    if (rawSecrets !== undefined) {
      if (!isPlainObject(rawSecrets)) {
        problems.push("plugin-secrets.json: not an object");
      } else {
        hasSecrets = Object.values(rawSecrets).some(
          (entries) => isPlainObject(entries) && Object.keys(entries).length > 0,
        );
      }
    }
  } catch {
    // Never echo the parser's message: it quotes a piece of the file, and this file holds (sealed) secrets.
    problems.push("plugin-secrets.json: could not be read (not valid JSON); its contents are not shown");
  }

  // folders.json
  let folders: string[] = [];
  try {
    const rawFolders = readJSON(join(root, "folders.json"));
    if (rawFolders !== undefined) {
      if (!Array.isArray(rawFolders)) {
        problems.push("folders.json: not a list");
      } else {
        folders = rawFolders.filter((entry): entry is string => typeof entry === "string" && isAbsolute(entry));
      }
    }
  } catch (error) {
    problems.push(`folders.json: ${errorText(error)}`);
  }

  // approved-commands.json
  let approvedCommands: unknown = {};
  try {
    const rawApproved = readJSON(join(root, "approved-commands.json"));
    if (rawApproved !== undefined) {
      if (!isPlainObject(rawApproved)) {
        problems.push("approved-commands.json: not an object");
      } else {
        approvedCommands = rawApproved;
      }
    }
  } catch (error) {
    problems.push(`approved-commands.json: ${errorText(error)}`);
  }

  return {
    bots,
    settings,
    pluginsState,
    pluginDirs,
    hasSecrets,
    folders,
    approvedCommands,
    problems,
  };
}

function readListFile(chatDir: string, name: Exclude<ChatFile, "chat.json" | "subagents.json">, problems: string[]): unknown[] {
  try {
    const value = readJSON(join(chatDir, name));
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`${name}: not a list`);
      return [];
    }
    return value;
  } catch (error) {
    problems.push(`${name}: ${errorText(error)}`);
    return [];
  }
}

function readSubagentStepsReadOnly(stepsPath: string, maxBytes = READ_TAIL_BYTES): SubagentHistory {
  let fd: number;
  try {
    fd = openSync(stepsPath, "r");
  } catch {
    return { runs: [], steps: [] };
  }
  try {
    const size = statSync(stepsPath).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!n) break;
      offset += n;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const cut = text.indexOf("\n");
      text = cut < 0 ? "" : text.slice(cut + 1);
    }
    return foldLines(text.split("\n"));
  } finally {
    closeSync(fd);
  }
}

const isValidStep = (value: unknown): value is StepRecord =>
  isPlainObject(value) && typeof value.id === "string";

function readSubagentsReadOnly(chatDir: string, problems: string[]): Read2xSubagent[] {
  const file = join(chatDir, "subagents.json");
  let value: unknown;
  try {
    value = readJSON(file);
  } catch (error) {
    problems.push(`subagents.json: ${errorText(error)}`);
    return [];
  }

  if (value === undefined) {
    if (!existsSync(`${file}.journal`)) return [];
    value = [];
  }

  if (isPlainObject(value) && value.format === INDEX_FORMAT && Array.isArray(value.subagents)) {
    const out: Read2xSubagent[] = [];
    for (const row of value.subagents) {
      if (!isPlainObject(row) || typeof row.id !== "string" || !row.id) continue;
      const stepsPath = join(chatDir, "subagents", subagentFileName(row.id));
      const history = readSubagentStepsReadOnly(stepsPath);
      out.push({ index: row, history });
    }
    return out;
  }

  // Pre-2.1 format (array or botling-history-v1 checkpoint + optional .journal/): read strictly read-only.
  try {
    const rows = readLegacyRows(file, value);
    const seen = new Set<string>();
    const out: Read2xSubagent[] = [];
    for (const raw of rows) {
      if (!isPlainObject(raw) || typeof raw.id !== "string" || typeof raw.startedAt !== "number" || seen.has(raw.id)) continue;
      seen.add(raw.id);
      const entry = indexEntry(raw);
      const earlier = Array.isArray(raw.previousRuns) ? raw.previousRuns.filter(isPlainObject) : [];
      const steps = Array.isArray(raw.steps) ? raw.steps.filter(isValidStep) : [];
      const runs = earlier.map((run) => ({
        run: {
          execution: run.execution,
          prompt: run.prompt as string | undefined,
          status: run.status as string | undefined,
          startedAt: run.startedAt as number | undefined,
          endedAt: run.endedAt as number | undefined,
          result: run.result as string | undefined,
        } satisfies RunMeta,
        steps: Array.isArray(run.steps) ? run.steps.filter(isValidStep) : [],
      }));
      entry.toolCount = steps.filter((step) => step.kind === "tool" || step.kind === "subagent").length;
      entry.stepCount = steps.length;
      if (earlier.length) entry.runs = earlier.length;
      out.push({ index: entry, history: { runs, steps } });
    }
    return out;
  } catch (error) {
    problems.push(`subagents.json: ${errorText(error)}`);
    return [];
  }
}

/** Reads one bot's chat files (`chat.json`, `pins.json`, `specs.json`, `tasks.json`, `subagents.json`, `bot.json`), strictly read-only. */
export function readChat(bot: Pick<Read2xBot, "chatDir">): Read2xChat {
  const problems: string[] = [];

  // chat.json
  let chat: ChatRecord[] = [];
  try {
    const rawChat = readJSON(join(bot.chatDir, "chat.json"));
    if (rawChat !== undefined) {
      if (!Array.isArray(rawChat)) {
        problems.push("chat.json: not a list of chat lines");
      } else {
        chat = rawChat.filter(isChatRecord);
      }
    }
  } catch (error) {
    problems.push(`chat.json: ${errorText(error)}`);
  }

  // lists
  const pins = readListFile(bot.chatDir, "pins.json", problems);
  const specs = readListFile(bot.chatDir, "specs.json", problems);
  const tasks = readListFile(bot.chatDir, "tasks.json", problems);

  // subagents
  const subagents = readSubagentsReadOnly(bot.chatDir, problems);

  // bot.json
  let settings: Record<string, unknown> = {};
  try {
    const rawBot = readJSON(join(bot.chatDir, "bot.json"));
    if (rawBot !== undefined) {
      if (!isPlainObject(rawBot)) {
        problems.push("bot.json: not an object");
      } else {
        settings = rawBot;
      }
    }
  } catch (error) {
    problems.push(`bot.json: ${errorText(error)}`);
  }

  return { chat, pins, specs, tasks, subagents, settings, problems };
}
