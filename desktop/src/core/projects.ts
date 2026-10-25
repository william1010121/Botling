// The main bot's world as 1.x builds it (Workspace.swift: addProject, proposeProjects, projectFolders,
// projectBriefing, deliverInboxes, refreshWaiting; ProjectBotNaming.swift; MemoryFile.swift). Pure
// helpers here; the core (server.ts) owns the bots they act on.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "./durable/atomic";
import { readJSON } from "./store/bot-store";
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
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  }
  if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
  if (!value.startsWith("/")) return null;
  const standard = resolve(value);
  return standard.length > 1 && standard.endsWith("/") ? standard.slice(0, -1) : standard;
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

/** Adds a row to projects.json (1.x's format: {id, name, folder as a file URL, avatar}), keeping the rows and keys there. */
export function saveProjectRow(root: string, row: { id: string; name: string; folder: string; avatar: string }) {
  let rows: unknown[] = [];
  try {
    const value = readJSON(Layout.projectsFile(root));
    if (Array.isArray(value)) rows = value;
  } catch { /* a broken file reads as none, as in 1.x; it is written anew */ }
  let url = pathToFileURL(row.folder).href;
  if (!url.endsWith("/")) url += "/";
  rows.push({ id: row.id, name: row.name, folder: url, avatar: row.avatar });
  mkdirSync(root, { recursive: true });
  writeFileAtomic(Layout.projectsFile(root), JSON.stringify(rows));
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
