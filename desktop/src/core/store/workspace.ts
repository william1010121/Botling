// Where everything sits under the data folder: the same layout as the Swift app's
// `Workspace.Layout`, so a 1.x folder can be read as it is and 2.0's own folder stays readable by
// the same code.
//
//   <root>/main/                 the main bot: its chat files, and its working folder (memory.md)
//   <root>/projects.json         the projects and bots (Workspace.Project rows)
//   <root>/projects/<ID>/        each project's or bot's chat files (BotStore)
//   <root>/bots/<ID>/            a bot of its own: its working folder (.bot/memory.md, …)
//   <root>/settings.json         app settings (AppSettings)
//   <root>/import.json           2.0 only: what the first-launch import brought over
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON } from "./bot-store";
import { MAIN_BOT_ID, MAINTAINER_ID, isProjectRecord, type ProjectRecord } from "./records";

export const Layout = {
  mainBot: (root: string) => join(root, "main"),
  bot: (root: string, id: string) => join(root, "projects", id),
  projectsFile: (root: string) => join(root, "projects.json"),
  standalone: (root: string, id: string) => join(root, "bots", id),
  settings: (root: string) => join(root, "settings.json"),
  importRecord: (root: string) => join(root, "import.json"),
};

/** The tools every bot uses without asking (`BotProfile.toolbox`, without claude.ai Artifact). */
export const TOOLBOX = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "Task", "SendMessage"];

/** Who a bot is and where it works (`BotProfile`). */
export interface BotProfile {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  avatar: string;
  /** Its working folder: where its agent runs. */
  folder: string;
  /** memory.md, relative to `folder`. */
  memoryPath: string;
  /** Where its chat files are. */
  storeDir: string;
  /** Tools it uses without asking; anything else it asks for (an approval). */
  tools: string[];
  /** What it is for, for a bot of its own. */
  job: string | null;
  /** Why it cannot run (its folder is gone), or null. */
  problem: string | null;
}

export function mainProfile(root: string): BotProfile {
  const home = Layout.mainBot(root);
  // The main bot asks before each command: its folder is no project to build or test in.
  return { id: MAIN_BOT_ID, name: "Main bot", role: "main", avatar: "circle", folder: home, memoryPath: "memory.md", storeDir: home, tools: TOOLBOX, job: null, problem: null };
}

export function projectProfile(root: string, project: ProjectRecord): BotProfile {
  let folder: string;
  let problem: string | null = null;
  try {
    folder = resolve(project.folder.startsWith("file:") ? fileURLToPath(project.folder) : project.folder);
  } catch {
    folder = project.folder;
    problem = `Its folder (${project.folder}) is not a path on this computer.`;
  }
  if (!problem && !(existsSync(folder) && statSync(folder).isDirectory())) problem = `Its folder ${folder} is not there.`;
  const job = typeof project.job === "string" ? project.job : null;
  return {
    id: project.id,
    name: project.name,
    role: job === null ? "manager" : "bot",
    avatar: project.avatar,
    folder,
    memoryPath: ".bot/memory.md",
    storeDir: Layout.bot(root, project.id),
    // A manager runs commands in its project freely; a bot of its own asks before each command.
    tools: job === null ? [...TOOLBOX, "Bash"] : TOOLBOX,
    job,
    problem,
  };
}

/** projects.json's rows (Maintainer is never in it; a broken file reads as none, as in 1.x). */
export function loadProjects(root: string): { projects: ProjectRecord[]; problem: string | null } {
  try {
    const value = readJSON(Layout.projectsFile(root));
    if (value === undefined) return { projects: [], problem: null };
    if (!Array.isArray(value)) return { projects: [], problem: "projects.json is not a list" };
    return { projects: value.filter(isProjectRecord).filter((project) => project.id !== MAINTAINER_ID), problem: null };
  } catch (error) {
    return { projects: [], problem: (error as Error).message };
  }
}

/** The main bot and every project and bot, in the left column's order. */
export function loadProfiles(root: string): { profiles: BotProfile[]; problem: string | null } {
  mkdirSync(Layout.mainBot(root), { recursive: true });
  const { projects, problem } = loadProjects(root);
  return { profiles: [mainProfile(root), ...projects.map((project) => projectProfile(root, project))], problem };
}
