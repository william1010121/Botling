// Maintainer's library functions (moved out of maintainer.ts, M7-S13): the library's own files, git for the
// library, installing a plugin from outside, and the helpers for requests and problem reports. maintainer.ts
// re-exports every public name from here, so no importer changes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Bot } from "./bot";
import type { ComponentLibrary } from "./components/library";
import { OLDER_PREVIEW_TEMPLATES, PREVIEW_ABOUT, PREVIEW_TEMPLATE } from "./components/builtins";
import { PAGE_COMPONENT } from "./preview-url";
import { writeFileAtomic } from "./durable/atomic";
import { componentEditorAgent, pluginGuide } from "./maintainer-text";
import { GUIDE_FOLDER, pluginGuideFiles } from "./plugin-guide-text";
import { checkPlugin, ENGINE_RANGE, PERMISSIONS, title, type PluginManifest } from "./plugins/manifest";
import type { Plugins } from "./plugins";
import { swiftPrettyJSON } from "./swift-json";

// ---------------------------------------------------------------------------------------------
// The library's own files (`prepareComponentPlugin`, `prepareCorePlugin`, `writeLibraryGuide`)

/** A plugin the app writes itself (`PluginManifest.builtIn(...).fileText`). */
export function builtInManifest(name: string, displayName: string, description: string, permissions: string[], extra: { claude?: string; components?: string } = {}): string {
  const manifest: Record<string, unknown> = {
    name, displayName, version: "1.0.0", description, license: "GPL-3.0-or-later", engines: { ccb: ENGINE_RANGE },
    ccb: { permissions, ...(extra.claude ? { claude: extra.claude } : {}), ...(extra.components ? { contributes: { components: extra.components } } : {}) },
  };
  return swiftPrettyJSON(manifest, { escapeSlashes: false }) + "\n";
}

/** The `.claude-plugin/plugin.json` of a Claude part (`PluginManifest.claudePluginText`). */
export function claudePluginText(name: string, description: string): string {
  return swiftPrettyJSON({ name, version: "1.0.0", description, author: { name: "Botling" } }, { escapeSlashes: false }) + "\n";
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readText = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return null; } };

/** The component editor's file as builds before 1.10.1 wrote it (hashes, `legacyComponentEditorHashes`): replaced without asking. */
const LEGACY_EDITOR_HASHES = new Set([
  "c7ff05198aa1eed4134e3248d47fbf1d4d577b27a8b4013fa4f6fd4cd60f7516",
  "4cad9d371e5e4259d4ac45d729c2c94a32f4bc9890a0b7560122027e2c92cea6",
  "63a27b73cc7637548fde9a19e3a1075dae2215f524484ecbd76ae9d5f440ddb9",
  "1d9ebab6f2f968ed5ac6e941a21322775487a0cf6925aa2eb8adcf287e223e3c",
]);

/**
 * Writes what the app keeps in the library: ccb-components (the component library), ccb-core (the
 * component editor agent, on `model`) and PLUGINS.md (naming `builtIns`, the built-in plugins' folder; a small index,
 * with its reference files and templates in plugins-guide/). The
 * editor's file follows the app, but only over a file the app wrote itself (or an older app's text): an edited
 * one stays (true is returned; 1.x then asks whether to keep it, 2.0 keeps it and says so in the log).
 */
export function prepareLibrary(root: string, model = "sonnet", builtIns: string | null = null): { editedEditor: boolean } {
  const library = join(root, "plugins");
  mkdirSync(join(library, "ccb-components", "components"), { recursive: true });
  const components = join(library, "ccb-components", "package.json");
  if (!existsSync(components)) {
    writeFileAtomic(components, builtInManifest("ccb-components", "Component library", "Components shown in the chat (choices and so on). One folder per component: template.html and about.md.", [], { components: "components" }));
  }
  // The preview card is botling.cards' (a built-in plugin) since step M11: a copy an app wrote here (1.x's
  // `seedDefaults`) that nobody edited goes, so the built-in one shows and follows the app; an edited one stays.
  const preview = join(library, "ccb-components", "components", PAGE_COMPONENT);
  if ([PREVIEW_TEMPLATE, ...OLDER_PREVIEW_TEMPLATES].includes(readText(join(preview, "template.html")) ?? "") && readText(join(preview, "about.md")) === PREVIEW_ABOUT) {
    for (const file of ["template.html", "about.md"]) rmSync(join(preview, file), { force: true });
    try { if (!readdirSync(preview).length) rmSync(preview, { recursive: true }); } catch { /* gone */ }
  }
  const core = join(library, "ccb-core");
  const editor = join(core, "claude", "agents", "component-editor.md");
  const recordFile = join(root, "component-editor.json");
  const isNew = !existsSync(core);
  let edited = false;
  if (isNew || existsSync(join(core, "claude", "agents"))) {
    const desired = componentEditorAgent(model);
    let record: { written?: string; kept?: string } = {};
    try { record = JSON.parse(readFileSync(recordFile, "utf8")); } catch { /* none yet */ }
    const before = JSON.stringify(record);
    const current = readText(editor);
    const hash = current === null ? null : sha256(current);
    if (current === desired) record.written = sha256(desired);
    else if (current === null || hash === record.written || (hash && LEGACY_EDITOR_HASHES.has(hash))) {
      writeFileAtomic(editor, desired);
      record = { written: sha256(desired) };
    } else if (hash !== record.kept) edited = true;
    if (JSON.stringify(record) !== before) writeFileAtomic(recordFile, JSON.stringify(record));
  }
  if (isNew) {
    writeFileAtomic(join(core, "claude", ".claude-plugin", "plugin.json"), claudePluginText("ccb-core", "Agents Botling uses itself."));
    writeFileAtomic(join(core, "package.json"), builtInManifest("ccb-core", "Botling core", "Agents Botling uses itself: component-editor edits component templates (its model is set in Settings).", ["claude"], { claude: "claude" }));
  }
  const guide = join(library, "PLUGINS.md");
  const text = builtIns ? pluginGuide(builtIns) : pluginGuide();
  if (readText(guide) !== text) writeFileAtomic(guide, text);
  // The index's on-demand files (references, templates): the app's own, rewritten when the app's text changes.
  for (const [path, content] of Object.entries(pluginGuideFiles())) {
    const file = join(library, GUIDE_FOLDER, path);
    if (readText(file) !== content) { mkdirSync(dirname(file), { recursive: true }); writeFileAtomic(file, content); }
  }
  return { editedEditor: edited };
}

// ---------------------------------------------------------------------------------------------
// git for the library (`PluginLibraryGit`): Botling's own commits are signed "Botling".

/** git from the usual places; /usr/bin/git only when the developer tools are installed (else it pops up an installer). */
export function locateGit(): string | null {
  const named = process.env.BOTLING_GIT_PATH;
  if (named) return existsSync(named) ? named : null;
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]) {
    if (!existsSync(candidate)) continue;
    if (candidate === "/usr/bin/git" && process.platform === "darwin") {
      const tools = spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
      if (tools.status !== 0) return null;
    }
    return candidate;
  }
  return null;
}

export class LibraryGit {
  private prepared = false;
  constructor(readonly folder: string, readonly git: string | null = locateGit()) {}

  run(args: string[]): { ok: boolean; output: string } {
    if (!this.git) return { ok: false, output: "git not found." };
    const result = spawnSync(this.git, ["-c", "user.name=Botling", "-c", "user.email=ccb@localhost", "-c", "commit.gpgsign=false", ...args], {
      cwd: this.folder, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000,
    });
    return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
  }

  /** Changes under `path` not committed yet (`isDirty`). */
  isDirty(path: string): boolean {
    return !!this.run(["status", "--porcelain", "--", path]).output;
  }

  /** Commits touching `path`, newest first (`commits`). */
  commits(path: string): string[] {
    const result = this.run(["log", "--format=%H", "--", path]);
    return result.ok ? result.output.split("\n").filter(Boolean) : [];
  }

  /** There is an earlier version of `path` to go back to (`hasPrevious`). */
  hasPrevious(path: string): boolean {
    if (!this.git || !existsSync(join(this.folder, ".git"))) return false;
    const count = this.commits(path).length;
    return count >= 2 || (count >= 1 && this.isDirty(path));
  }

  /**
   * Puts `path` back the way it was before its last change, as a new commit (`revert(_:label:)`). Changes
   * not committed yet are committed first, so nothing is lost. Null when done, else why not.
   */
  revert(path: string, label: string): string | null {
    if (!this.git) return "git not found, so it can't be reverted.";
    if (this.isDirty(path)) {
      this.run(["add", "-A", "--", path]);
      this.run(["commit", "-q", "-m", `${label}: uncommitted changes (saved automatically before reverting)`, "--", path]);
    }
    const history = this.commits(path);
    const last = history[0];
    if (!last) return `"${label}" has no version history yet.`;
    if (history.length < 2 && !this.run(["rev-parse", "--verify", "-q", `${last}^`]).ok) return `"${label}" has no previous version.`;
    if (this.run(["cat-file", "-e", `${last}^:${path}`]).ok) {
      this.run(["rm", "-r", "-q", "--cached", "--", path]);
      rmSync(join(this.folder, path), { recursive: true, force: true });
      if (!this.run(["checkout", `${last}^`, "--", path]).ok) return "Couldn't restore the previous version.";
    } else if (!this.run(["rm", "-r", "-q", "--", path]).ok) {
      // It did not exist before that change.
      return "Couldn't restore the previous version.";
    }
    this.run(["add", "-A", "--", path]);
    const commit = this.run(["commit", "-q", "-m", `Revert ${label} to the previous version`, "--", path]);
    return commit.ok ? null : commit.output;
  }

  /** Makes the library a repo with everything committed, the first time (before handing Maintainer work). */
  prepare() {
    if (this.prepared || !this.git) return;
    this.prepared = true;
    if (existsSync(join(this.folder, ".git"))) return;
    mkdirSync(this.folder, { recursive: true });
    const ignore = join(this.folder, ".gitignore");
    if (!existsSync(ignore)) writeFileAtomic(ignore, "node_modules/\n.DS_Store\n");
    this.run(["init", "-q"]);
    this.run(["add", "-A"]);
    this.run(["commit", "-q", "-m", "Botling plugin library"]);
    this.onPrepared?.();
  }

  /** The repo was just made (the library asks about history again). */
  onPrepared: (() => void) | null = null;
}

// ---------------------------------------------------------------------------------------------
// Installing a plugin from outside (PluginInstaller.swift): fetched, checked, then asked about.

export type InstallSource = { kind: "folder"; path: string } | { kind: "git"; url: string } | { kind: "npm"; name: string } | { kind: "archive"; url: string };

/** What kind of source `text` is (`PluginInstaller.classify`). */
export function classifySource(text: string): InstallSource | null {
  const source = text.trim();
  if (!source) return null;
  if (source.startsWith("/") || source.startsWith("~")) {
    const path = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
    try { return statSync(path).isDirectory() ? { kind: "folder", path: resolve(path) } : null; } catch { return null; }
  }
  try {
    const url = new URL(source);
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    const path = url.pathname.toLowerCase();
    if ((scheme === "http" || scheme === "https") && (path.endsWith(".zip") || path.endsWith(".tgz") || path.endsWith(".tar.gz"))) return { kind: "archive", url: source };
    if (["http", "https", "ssh", "git", "file"].includes(scheme)) return { kind: "git", url: source };
  } catch { /* not a URL */ }
  if (source.startsWith("git@")) return { kind: "git", url: source };
  if (/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9.^~<>=*-]+)?$/.test(source)) return { kind: "npm", name: source };
  return null;
}

export interface InstallProposal {
  source: string;
  /** The fetched plugin folder, in the staging folder until installed. */
  folder: string;
  work: string;
  manifest: PluginManifest;
  author: string | null;
  mcpServers: string[];
  problems: string[];
  /** What was checked about where it came from (a catalog install: the commit and the files' hash). */
  verified?: string;
  /** The version it replaces in the library (an update). */
  replacing?: string;
  /** The folder hash the catalog check verified (plugin-store.ts): recorded at install so a built-in's update keeps its rights while the files stay as checked. */
  verifiedSha256?: string;
}

/** The text of the question (`InstallProposal.summary`). */
export function installSummary(proposal: InstallProposal): string {
  const { manifest } = proposal;
  const lines = [proposal.replacing ? `Update the plugin "${title(manifest)}" from ${proposal.replacing} to ${manifest.version}?` : `Install the plugin "${title(manifest)}" ${manifest.version}?`];
  if (manifest.description) lines.push(manifest.description);
  lines.push(`Source: ${proposal.source}`);
  if (proposal.verified) lines.push(`Checked: ${proposal.verified}`);
  lines.push(`Author: ${proposal.author ?? "not given"}; license: ${manifest.license ?? "not given"}`);
  const permissions = (manifest.ccb?.permissions ?? []).map((permission) => PERMISSIONS[permission] ?? `"${permission}"`);
  lines.push(permissions.length ? `It will: ${permissions.join(", ")}` : "It asks for no permissions.");
  if (proposal.mcpServers.length) lines.push(`It gives the bots new tools (MCP): ${proposal.mcpServers.join(", ")}`);
  if (manifest.ccb?.host) lines.push("It has a program part that runs on your computer (permissions are only declared, not sandboxed).");
  return lines.join("\n");
}

/** Fetches `source` into a new folder under `staging` and reads it (`PluginInstaller.fetch` + `read`). Folders and git only, for now. */
export function fetchPlugin(source: string, staging: string, git: string | null): InstallProposal {
  const kind = classifySource(source);
  if (!kind) throw new Error(`Can't tell what "${source}" is: it must be a folder, a git URL, an npm package name, or a .zip/.tgz URL.`);
  if (kind.kind === "npm" || kind.kind === "archive") throw new Error("Botling 2.0 installs plugins from a folder or a git URL only, for now.");
  const work = join(staging, randomUUID());
  mkdirSync(work, { recursive: true });
  let fetched: string;
  if (kind.kind === "folder") {
    fetched = join(work, kind.path.split("/").filter(Boolean).at(-1) ?? "plugin");
    cpSync(kind.path, fetched, { recursive: true, filter: (from) => !from.split("/").includes("node_modules") });
    rmSync(join(fetched, ".git"), { recursive: true, force: true });
  } else {
    if (!git) throw new Error("git not found, so a git URL can't be fetched.");
    fetched = join(work, "repo");
    try {
      execFileSync(git, ["clone", "--depth", "1", "--quiet", kind.url, fetched], { cwd: work, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000, stdio: "pipe" });
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      const output = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message).trim();
      throw new Error(`git failed: ${output.slice(-300)}`);
    }
    rmSync(join(fetched, ".git"), { recursive: true, force: true });
  }
  return readProposal(fetched, work, source);
}

/** Reads a fetched plugin folder for the install card: its manifest, author, MCP servers and the check's problems. */
export function readProposal(fetched: string, work: string, source: string): InstallProposal {
  const problems = checkPlugin(fetched);
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(join(fetched, "package.json"), "utf8")); } catch { /* checked above */ }
  const manifest: PluginManifest = typeof raw.name === "string" && typeof raw.version === "string" ? raw as unknown as PluginManifest : { name: fetched.split("/").at(-1) ?? "plugin", version: "?" };
  const author = typeof raw.author === "string" ? raw.author : typeof (raw.author as { name?: unknown })?.name === "string" ? (raw.author as { name: string }).name : null;
  let mcpServers: string[] = [];
  const claude = manifest.ccb?.claude;
  if (claude) {
    try {
      const value = JSON.parse(readFileSync(join(fetched, claude, ".mcp.json"), "utf8")) as Record<string, unknown>;
      mcpServers = Object.keys((value.mcpServers as Record<string, unknown> | undefined) ?? value).sort();
    } catch { /* none */ }
  }
  return { source, folder: fetched, work, manifest, author, mcpServers, problems };
}

// ---------------------------------------------------------------------------------------------
// Requests

export interface ComponentAsk {
  /** The id Maintainer answers it by (`<component-declined id="…">`). */
  key: string;
  name: string;
  botId: string;
  request: string;
  userAsked: string;
  stamp: string;
  changing: boolean;
  /** The task id of the card worker that asked (the answer goes to it): absent when the bot asked. */
  card?: string;
}

export interface MaintainerDeps {
  root: string;
  maintainerId?: string;
  maintainer: () => Bot | null;
  mainBot: () => Bot | null;
  bots: () => Bot[];
  library: ComponentLibrary;
  plugins: () => Plugins | null;
  /** Looks at the library on disk now (the core's scan: views redraw, asked components are delivered). */
  rescan?: () => void;
  log: (line: string) => void;
}

export const shortened = (text: string, limit: number) => {
  const chars = [...text.trim()];
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : chars.join("");
};
export const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? text;

/** How the note to a bot whose component arrived (or changed) starts (`Workspace.arrivalLead`). */
export const arrivalLead = (name: string, changed: boolean) =>
  "(App: Maintainer " + (changed ? `changed the component "${name}" as you asked` : `added the component "${name}" to your list`);

/** What Maintainer is told of your answer to a folder question (`Workspace.folderAnswer`). */
export function folderAnswer(folder: string, allowed: boolean): string {
  return allowed
    ? `(App) The user agreed: you can now read ${folder} (read only, do not change files there). Carry on with what you were doing.`
    : `(App) The user did not allow you to read ${folder}. Find another way, or explain that it can't be done.`;
}

/** What a card's owner (botling.board's pin) says of it for a problem report: how it refreshes, and when its data is from (Swift seconds). */
export interface ReportCard { words: string; when: number | null }

/** "2026-10-24 18:54:12", in the user's time zone (`reportStamp`); `date` in Swift seconds. */
export function reportStamp(date: number): string {
  const d = new Date(Date.UTC(2001, 0, 1) + date * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The request a problem report makes (`problemReport`): where it came from, the user's words, then the card's refresh, when its data is from and its screenshot. */
export function problemReport(text: string, chat: string, pin: ReportCard | null, screenshot: string | null): string {
  const card: string[] = [];
  if (pin) {
    card.push(pin.words);
    if (typeof pin.when === "number") card.push(`data from ${reportStamp(pin.when)}`);
  }
  const notes: string[] = [];
  if (card.length) notes.push(`Card: ${card.join("; ")}.`);
  if (screenshot) notes.push(`Screenshot of the card: ${screenshot}`);
  const base = `Problem reported from the card in ${chat}'s chat: ${text}`;
  return notes.length ? `${base} (${notes.join(" ")})` : base;
}
