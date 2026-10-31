// The main bot's world as 1.x builds it (Workspace.swift: addProject, proposeProjects, projectFolders,
// projectBriefing, deliverInboxes, refreshWaiting; ProjectBotNaming.swift; MemoryFile.swift). Pure
// helpers here; the core (server.ts) owns the bots they act on.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "./durable/atomic";
import { readJSON } from "./store/bot-store";
import { characterPrefix } from "./briefing";
import { Layout } from "./store/workspace";

/** The shapes new projects get, in order (`Workspace.avatars`, the main bot's circle left out). */
export const HANDED_OUT = ["square", "triangle", "hexagon", "star", "diamond", "clover", "heart", "drop", "pentagon", "cloud", "octagon", "moon", "pill", "ghost", "burst"];

/** The first shape no project or bot has yet (`nextAvatar`). */
export function nextAvatar(used: string[]): string {
  const taken = new Set(used);
  return HANDED_OUT.find((shape) => !taken.has(shape)) ?? HANDED_OUT[used.length % HANDED_OUT.length]!;
}

/** An absolute path, `~…`, or a file:// URL as a folder path; null for anything relative (`folderURL`). */
export function folderPath(path: string): string | null {
  let value = path.trim();
  if (value.startsWith("file://")) {
    try { value = fileURLToPath(value); } catch { return null; }
  }
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) value = homedir() + value.slice(1);
  if (!isAbsolute(value)) return null;
  // resolve() already drops a trailing separator, except on a root.
  return resolve(value);
}

/** What marks a folder as a project's own (`projectMarkers`), and folders never looked into. */
const MARKERS = new Set([".git", "package.json", "Package.swift", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "CMakeLists.txt", "Makefile", "manifest.json"]);
const SKIPPED = new Set(["node_modules", "build", "dist", "target", "DerivedData", "Pods", "vendor", "venv"]);
export const PROJECT_SEARCH_DEPTH = 5;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const isFolder = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const visible = (folder: string) => { try { return readdirSync(folder).filter((name) => !name.startsWith(".")).sort(collator.compare); } catch { return null; } };

/** The projects below `folder`: the outermost folders with a project marker, sorted (`projectFolders`). */
export function projectFolders(folder: string, depth = PROJECT_SEARCH_DEPTH): string[] {
  if (depth <= 0) return [];
  const inside = visible(folder);
  if (!inside) return [];
  const found: string[] = [];
  for (const name of inside) {
    const child = join(folder, name);
    if (!isFolder(child) || SKIPPED.has(name) || name.endsWith(".xcodeproj") || name.endsWith(".app")) continue;
    let names: string[] = [];
    try { names = readdirSync(child); } catch { /* unreadable */ }
    if (names.some((entry) => MARKERS.has(entry) || entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace"))) found.push(child);
    else found.push(...projectFolders(child, depth - 1));
  }
  return found;
}

/** Folders directly inside (`<folder>/*`), not hidden ones. */
export function childFolders(folder: string): string[] | null {
  const inside = visible(folder);
  return inside ? inside.map((name) => join(folder, name)).filter(isFolder) : null;
}

/** A project's name (`ProjectBotNaming.defaultName`): its folder's name; Botling's own source is "botling". */
export function defaultName(folder: string): string {
  const name = basename(folder);
  if (["claudecodebot", "botling"].includes(name.toLowerCase()) && isOwnSource(folder)) return "botling";
  return name;
}

function isOwnSource(folder: string): boolean {
  try {
    const manifest = readFileSync(join(folder, "Package.swift"), "utf8");
    if (!manifest.includes('name: "ClaudeCodeBotCore"') || !(manifest.includes('name: "botling"') || manifest.includes('name: "ClaudeCodeBot"'))) return false;
    return existsSync(join(folder, "Sources", "ClaudeCodeBot", "ClaudeCodeBotApp.swift"));
  } catch {
    return false;
  }
}

/** `<project>/.bot/` with its own .gitignore (`*`), so it stays out of the project's git status (`prepareNotesFolder`). */
export function prepareNotesFolder(folder: string) {
  const notes = join(folder, ".bot");
  mkdirSync(notes, { recursive: true });
  const ignore = join(notes, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

function projectRows(root: string): unknown[] {
  try {
    const value = readJSON(Layout.projectsFile(root));
    if (Array.isArray(value)) return value;
  } catch { /* a broken file reads as none, as in 1.x; it is written anew */ }
  return [];
}

/** A folder as projects.json keeps it: a file URL ending in "/". */
export function folderURLText(folder: string): string {
  const url = pathToFileURL(folder).href;
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Adds a row to projects.json (1.x's format: {id, name, folder as a file URL, avatar}; a bot of its own
 * also its `job`, and the `plugin` that made it), keeping the rows and keys there.
 */
export function saveProjectRow(root: string, row: { id: string; name: string; folder: string; avatar: string; job?: string; plugin?: string }) {
  const rows = projectRows(root);
  rows.push({ id: row.id, name: row.name, folder: folderURLText(row.folder), avatar: row.avatar, ...(row.job !== undefined ? { job: row.job } : {}), ...(row.plugin ? { plugin: row.plugin } : {}) });
  mkdirSync(root, { recursive: true });
  writeFileAtomic(Layout.projectsFile(root), JSON.stringify(rows));
}

/** Takes a row out of projects.json (by id), keeping the others as they are. The folder stays. */
export function removeProjectRow(root: string, id: string) {
  const rows = projectRows(root).filter((row) => !(row && typeof row === "object" && (row as { id?: unknown }).id === id));
  writeFileAtomic(Layout.projectsFile(root), JSON.stringify(rows));
}

/** A bot's name as it is kept (`Workspace.botName`): one line, no quotes or @ (nor < > \`), at most 40 characters. */
export function botName(name: string): string {
  const line = name.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/).find((piece) => piece.length > 0) ?? "";
  const spaces = /^[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
  const cleaned = [...line].filter((character) => !"\"@<>`".includes(character)).join("").replace(spaces, "");
  return characterPrefix(cleaned, 40).replace(spaces, "");
}

/** The first line of a text (`Workspace.firstLine`). */
export function firstLine(text: string): string {
  return text.split(/\r?\n|\r|\u2028|\u2029/).find((line) => line.length > 0) ?? text;
}

/** A section of a four-section memory.md (`MemoryFile.items`). */
export type MemorySection = "currentStatus" | "inProgress" | "waitingOnYou" | "decided";
const SECTIONS: MemorySection[] = ["currentStatus", "inProgress", "waitingOnYou", "decided"];
const HEADINGS: Record<MemorySection, string[]> = {
  currentStatus: ["Current status", "現在狀態"], inProgress: ["In progress", "進行中"], waitingOnYou: ["Waiting on you", "等你決定的事"], decided: ["Decided", "決定過的事"],
};

/** Nothing but punctuation, or a whole line in brackets: a remark, not an item. */
function isEmptyMark(item: string): boolean {
  if (!item.replace(/[\s\p{P}\p{S}]/gu, "")) return true;
  return ([["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"]] as const).some(([open, close]) => item.startsWith(open) && item.endsWith(close) && !item.slice(1, -1).includes(open));
}

export function memoryItems(text: string, section: MemorySection): string[] {
  const lines = text.split("\n").map((line) => line.trim());
  const headings = lines.filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
  const known = (heading: string) => SECTIONS.some((candidate) => HEADINGS[candidate].some((name) => heading.startsWith(name)));
  const byPlace = !headings.some(known) && headings.length === SECTIONS.length;
  const place = SECTIONS.indexOf(section);
  let seen = -1;
  let inSection = false;
  const items: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      seen++;
      const heading = line.slice(3);
      inSection = byPlace ? seen === place : HEADINGS[section].some((name) => heading.startsWith(name));
      continue;
    }
    if (!inSection || !line) continue;
    const item = line.replace(/^([-*•]|\d+\.)\s*/, "");
    if (!isEmptyMark(item)) items.push(item);
  }
  return items;
}

export function memoryItemsAt(file: string, section: MemorySection): string[] {
  try { return memoryItems(readFileSync(file, "utf8"), section); } catch { return []; }
}

/**
 * memory.md files read once per change: each file's text and sections are kept with its stat (mtime,
 * ctime, size, inode, in nanoseconds), so looking again at a file nobody wrote is one stat, not a read
 * and a parse. Used by what waits on you and the whiteboard, which look at every bot's memory often.
 */
export class MemoryFiles {
  private cache = new Map<string, { key: string; text: string; items: Partial<Record<MemorySection, string[]>> }>();

  private entry(file: string) {
    let key: string;
    try {
      const stat = statSync(file, { bigint: true });
      key = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.ino}`;
    } catch {
      this.cache.delete(file);
      return null;
    }
    const known = this.cache.get(file);
    if (known && known.key === key) return known;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { this.cache.delete(file); return null; }
    const fresh = { key, text, items: {} as Partial<Record<MemorySection, string[]>> };
    this.cache.set(file, fresh);
    return fresh;
  }

  /** The file's text ("" when it cannot be read). */
  text(file: string): string {
    return this.entry(file)?.text ?? "";
  }

  /** `memoryItemsAt`, parsed once per change of the file. The list is shared: callers do not change it. */
  items(file: string, section: MemorySection): readonly string[] {
    const entry = this.entry(file);
    if (!entry) return [];
    return (entry.items[section] ??= memoryItems(entry.text, section));
  }

  /** Forgets files no longer asked about (removed bots). */
  keepOnly(files: Iterable<string>) {
    const keep = new Set(files);
    for (const file of this.cache.keys()) if (!keep.has(file)) this.cache.delete(file);
  }
}

/** A row of the main bot's project list: its name, what goes in brackets, its memory and inbox files, an open question's first line. */
export interface BriefingRow { name: string; about: string; memory: string; inbox: string; question: string | null }

/**
 * `Workspace.projectBriefing`: the project list and the teams the main bot gets each time it wakes
 * (and with its routines): each project's and bot's memory and inbox file and a question waiting in
 * its own chat, Maintainer's, the <open-question> note when any of them asks, and the teams.
 */
export function projectBriefingText(input: { projects: BriefingRow[]; bots: BriefingRow[]; maintainer: BriefingRow; teams: { name: string; title: string; description: string }[] }): string {
  const note = (row: BriefingRow) => (row.question !== null ? `; open question in its chat: ${firstLine(row.question)}` : "");
  const line = (row: BriefingRow) => `- ${row.name} (${row.about}): memory file ${row.memory}; inbox file ${row.inbox}${note(row)}`;
  const projectLines = input.projects.length ? input.projects.map(line).join("\n") : "(No projects yet.)";
  const botLines = input.bots.length ? "\n(App: Bots of their own, which you reach the same way.)\n" + input.bots.map(line).join("\n") : "";
  const maintainerLine = line(input.maintainer);
  const asking = [...input.projects, ...input.bots, input.maintainer].some((row) => row.question !== null);
  const cardLine = asking ? '\n(App: A decision marked "open question in its chat" already has its card there. To bring it up, write <open-question from="its name"/> in your reply: the app shows that same card here. Never write a new choices block for it.)' : "";
  const teamLines = input.teams.map((team) => `- ${team.name} (${team.title}): ${team.description}`).join("\n");
  return `(App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)\n${projectLines}${botLines}\n${maintainerLine}${cardLine}\n(App: Temporary teams you can start, with <team name="name">task</team>.)\n${teamLines}`;
}
