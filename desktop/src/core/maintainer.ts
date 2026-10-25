// Maintainer: the built-in bot that looks after the plugin library (<core>/plugins, a git repo), as
// in 1.x (Workspace.swift: `maintainerProject`, `handToMaintainer`, `requestComponentChange`,
// `handle(_:from:)`, `proposeInstall`; Workspace+Components.swift: `componentAskNote`,
// `deliverAskedComponents`, `settleComponentAsks`, `declineComponentAsk`, `changeComponentList`).
//
// - Bots' <component> requests go to Maintainer with which bot asked and how full its list is; a
//   component already in the library goes on the bot's list at once. The bot hears back once Maintainer
//   gives (<give-component>), builds (it lands in the library) or changes it (its files change), or
//   declines (<component-declined id=…>).
// - <plugin> requests go to Maintainer as "X's request for Botling: …".
// - <install> never installs by itself: the plugin is fetched into a staging folder and checked, and
//   the user is asked in the main bot's chat (Install / Don't install); only "Install" puts it into the
//   library (and commits it).
// - Maintainer works in the library with 1.x's instructions (maintainer-text.ts, checked against the
//   Swift strings) and the component editor agent (ccb-core:component-editor, a Claude Code plugin agent
//   handed to claude with --plugin-dir).
//
// - <need-folder> (Phase 4c): Maintainer asks to read a folder outside the library; you are asked once in
//   its chat (Allow / Don't allow); allowed folders are kept in folders.json, given to its head as
//   `--add-dir` (its process starts again in the same session before its next message), and a folder
//   inside one allowed before is allowed at once (`requestFolder`, `answerFolder`).
//
// 2.0 gaps: component specs, reports, design flows and component shots are not ported; installs take a folder or
// a git URL (npm packages and archives: not yet).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Bot } from "./bot";
import type { ComponentLibrary } from "./components/library";
import { COMPONENT_LIMIT, safeName } from "./components/library";
import { writeFileAtomic } from "./durable/atomic";
import { componentEditorAgent, pluginGuide } from "./maintainer-text";
import { checkPlugin, ENGINE_RANGE, PERMISSIONS, title, type PluginManifest } from "./plugins/manifest";
import type { Plugins } from "./plugins";
import { swiftPrettyJSON } from "./plugins/registry";
import type { BotRequest } from "./reply";
import { MAINTAINER_ID } from "./store/records";
import { Layout, TOOLBOX, type BotProfile } from "./store/workspace";

export { MAINTAINER_ID };

/** Maintainer's profile (`BotProfile.maintainer`): a manager whose folder is the plugin library. */
export function maintainerProfile(root: string, instructions: string): BotProfile {
  return {
    id: MAINTAINER_ID, name: "Maintainer", role: "manager", avatar: "diamond", folder: join(root, "plugins"), memoryPath: ".bot/memory.md",
    storeDir: Layout.bot(root, MAINTAINER_ID), tools: [...TOOLBOX, "Bash"], job: null, problem: null, instructions,
  };
}

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
 * component editor agent, on `model`) and PLUGINS.md. The editor's file follows the app, but only over
 * a file the app wrote itself (or an older app's text): an edited one stays (true is returned; 1.x then
 * asks whether to keep it, 2.0 keeps it and says so in the log).
 */
export function prepareLibrary(root: string, model = "sonnet"): { editedEditor: boolean } {
  const library = join(root, "plugins");
  mkdirSync(join(library, "ccb-components", "components"), { recursive: true });
  const components = join(library, "ccb-components", "package.json");
  if (!existsSync(components)) {
    writeFileAtomic(components, builtInManifest("ccb-components", "Component library", "Components shown in the chat (choices and so on). One folder per component: template.html and about.md.", [], { components: "components" }));
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
  const text = pluginGuide();
  if (readText(guide) !== text) writeFileAtomic(guide, text);
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
  }
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
}

/** The text of the question (`InstallProposal.summary`). */
export function installSummary(proposal: InstallProposal): string {
  const { manifest } = proposal;
  const lines = [`Install the plugin "${title(manifest)}" ${manifest.version}?`];
  if (manifest.description) lines.push(manifest.description);
  lines.push(`Source: ${proposal.source}`);
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

interface ComponentAsk {
  /** The id Maintainer answers it by (`<component-declined id="…">`). */
  key: string;
  name: string;
  botId: string;
  request: string;
  userAsked: string;
  stamp: string;
  changing: boolean;
}

export interface MaintainerDeps {
  root: string;
  maintainer: () => Bot | null;
  mainBot: () => Bot;
  bots: () => Bot[];
  library: ComponentLibrary;
  plugins: () => Plugins | null;
  /** Looks at the library on disk now (the core's scan: views redraw, asked components are delivered). */
  rescan?: () => void;
  log: (line: string) => void;
}

const shortened = (text: string, limit: number) => {
  const chars = [...text.trim()];
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : chars.join("");
};
const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? text;

/** How the note to a bot whose component arrived (or changed) starts (`Workspace.arrivalLead`). */
export const arrivalLead = (name: string, changed: boolean) =>
  "(App: Maintainer " + (changed ? `changed the component "${name}" as you asked` : `added the component "${name}" to your list`);

/** What Maintainer is told of your answer to a folder question (`Workspace.folderAnswer`). */
export function folderAnswer(folder: string, allowed: boolean): string {
  return allowed
    ? `(App) The user agreed: you can now read ${folder} (read only, do not change files there). Carry on with what you were doing.`
    : `(App) The user did not allow you to read ${folder}. Find another way, or explain that it can't be done.`;
}

/** A path as 1.x reads `<need-folder>`'s (`expandingTildeInPath`, `standardizedFileURL`). */
export function standardFolder(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const folder = resolve("/", expanded);
  return folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
}

export class MaintainerDesk {
  readonly git: LibraryGit;
  private asks: ComponentAsk[] = [];
  private installing = new Set<string>();

  constructor(private readonly deps: MaintainerDeps) {
    this.git = new LibraryGit(join(deps.root, "plugins"));
  }

  private get maintainer() { return this.deps.maintainer(); }

  /** Gives Maintainer a job, the way the main bot hands work to a manager (`handToMaintainer`). */
  handTo(text: string) {
    const maintainer = this.maintainer;
    if (!maintainer) { this.deps.log(`no Maintainer for: ${text.slice(0, 200)}`); return; }
    this.git.prepare();
    try {
      maintainer.relay(text);
    } catch (error) {
      this.deps.log(`Maintainer could not take it: ${(error as Error).message}`);
    }
  }

  /** The requests in a bot's reply the app acts on (`Workspace.handle`); what it cannot do yet comes back. Acting waits until the reply is done. */
  handle(from: Bot, requests: BotRequest[]): BotRequest[] {
    const isMaintainer = from.id === MAINTAINER_ID;
    const left: BotRequest[] = [];
    const later: (() => void)[] = [];
    for (const request of requests) {
      switch (request.kind) {
        case "component":
          later.push(() => this.requestComponentChange(request.name, request.request, from.id === this.deps.mainBot().id ? "Main bot" : from.profile.name, from));
          break;
        case "plugin":
          if (!isMaintainer) later.push(() => this.handTo(`${from.id === this.deps.mainBot().id ? "Main bot" : from.profile.name}'s request for Botling: ${request.request}`));
          break;
        case "install":
          later.push(() => this.proposeInstall(request.source));
          break;
        case "giveComponent":
        case "takeComponent":
          if (isMaintainer) later.push(() => this.changeList(request.kind === "giveComponent", request.name, request.bot));
          break;
        case "componentDeclined":
          if (isMaintainer) later.push(() => this.decline(request.id, request.reason));
          break;
        case "folder":
          // Only Maintainer asks for folders (1.x leaves anyone else's tag alone).
          if (isMaintainer) later.push(() => this.requestFolder(request.path));
          break;
        default:
          left.push(request);
      }
    }
    if (later.length) setImmediate(() => { for (const act of later) { try { act(); } catch (error) { this.deps.log(`request: ${(error as Error).message}`); } } });
    return left;
  }

  // ------------------------------------------------------------------------------------------
  // Folders outside the library

  private get foldersFile() { return join(this.deps.root, "folders.json"); }

  /** Folders you let Maintainer read (folders.json: a list of paths, as 1.x keeps it). */
  approvedFolders(): string[] {
    try {
      const value = JSON.parse(readFileSync(this.foldersFile, "utf8"));
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")) : [];
    } catch {
      return [];
    }
  }

  private allowed(folder: string): boolean {
    return this.approvedFolders().some((approved) => folder === approved || folder.startsWith(approved.endsWith("/") ? approved : approved + "/"));
  }

  /** Maintainer asked to read `path` (`requestFolder`): you are asked once, in its chat; a folder allowed before, or one inside it, at once. */
  requestFolder(path: string) {
    const maintainer = this.maintainer;
    if (!maintainer || !path.trim()) return;
    const folder = standardFolder(path.trim());
    if (this.allowed(folder)) {
      try { maintainer.relay(`(App) ${folder} was already allowed before; you can read it directly.`); } catch (error) { this.deps.log(`folder: ${(error as Error).message}`); }
      return;
    }
    maintainer.appNotice(`Maintainer wants to read "${folder}". It will only read, never change files there. Allow it?`,
      [{ label: "Allow", detail: "Won't ask again" }, { label: "Don't allow" }],
      (index) => this.answerFolder(folder, index === 0),
      { sourceID: MAINTAINER_ID });
  }

  /** Your answer to a folder question (`answerFolder`): kept, and its process starts again with the folder before it carries on. */
  private answerFolder(folder: string, allowed: boolean) {
    const maintainer = this.maintainer;
    if (!maintainer) return;
    if (allowed && !this.allowed(folder)) {
      writeFileAtomic(this.foldersFile, JSON.stringify([...this.approvedFolders(), folder]));
      maintainer.restartBeforeNextMessage();
    }
    try { maintainer.relay(folderAnswer(folder, allowed)); } catch (error) { this.deps.log(`folder: ${(error as Error).message}`); }
  }

  // ------------------------------------------------------------------------------------------
  // Components

  /** Someone asked for a component change (`requestComponentChange`): Maintainer hands it to a component editor. */
  requestComponentChange(rawName: string, rawRequest: string, asker: string, bot: Bot | null) {
    const name = safeName(rawName);
    if (!name) return;
    const request = rawRequest.trim();
    const said = request || "see the attached pictures";
    const exists = this.deps.library.names.includes(name);
    const note = this.askNote(name, request, exists, bot);
    this.handTo(exists ? `${asker}'s request for the component "${name}": ${said}${note}` : `${asker} wants a new component "${name}": ${said}${note}`);
  }

  private giveComponent(name: string, bot: Bot): boolean {
    const list = bot.components;
    if (!list || !this.deps.library.names.includes(name)) return false;
    const own = bot.ownComponentNames;
    if (own.includes(name)) return true;
    if (own.length >= COMPONENT_LIMIT) return false;
    bot.setComponentList([...list, name]);
    return true;
  }

  private takeComponent(name: string, bot: Bot): boolean {
    const list = bot.components;
    if (!list?.includes(name)) return false;
    bot.setComponentList(list.filter((other) => other !== name));
    return true;
  }

  /** What Maintainer is told about the bot that asked (`componentAskNote`), after giving it at once when the library has it. */
  askNote(name: string, request: string, exists: boolean, bot: Bot | null): string {
    if (!bot || bot.components === null) return "";
    const own = bot.ownComponentNames;
    const limit = COMPONENT_LIMIT;
    const botName = this.nameOf(bot);
    const ask: ComponentAsk = {
      key: randomUUID().slice(0, 8).toLowerCase(), name, botId: bot.id, request, userAsked: shortened(bot.lastAsked, 300),
      stamp: this.deps.library.stampOf(name), changing: exists && own.includes(name),
    };
    const answerBack = ` If you will not or cannot do it, say why and end your reply with <component-declined id="${ask.key}">why, in one sentence for ${botName}</component-declined>; the app passes it on to ${botName}.`;
    const full = ` (App: ${botName} already has ${own.length} / ${limit} components. Add or build nothing for it: with a choices block of its components, ask the user which one to remove from ${botName}'s list first, then <take-component bot="${botName}">that name</take-component>.)`;
    if (exists && !own.includes(name)) {
      if (!this.giveComponent(name, bot)) {
        this.asks.push(ask);
        return full;
      }
      ask.changing = false;
      this.arrived(name, ask, bot, null);
      return ` (App: "${name}" is already in the library, so the app added it to ${botName}'s list and told ${botName}; nothing to build. Change it only if the request asks for a change.)`;
    }
    this.asks = this.asks.filter((other) => !(other.botId === bot.id && other.name === name));
    this.asks.push(ask);
    if (exists) return ` (App: ${botName} asked for this change.${answerBack})`;
    if (own.length >= limit) return full;
    return ` (App: ${botName} has ${own.length} / ${limit} components. Check the library first: if a component there already does this, build nothing and reply with <give-component bot="${botName}">its name</give-component>. Otherwise build it; once it is in the library the app adds it to ${botName}'s list.${answerBack})`;
  }

  private nameOf(bot: Bot) {
    return bot.id === this.deps.mainBot().id ? "Main bot" : bot.profile.name;
  }

  /** `componentArrived`: the bot now has `name` (by Maintainer, or the app at once); it is woken to answer what the user wanted. */
  private arrived(name: string, ask: ComponentAsk, bot: Bot, maker: string | null, changed = false) {
    const library = this.deps.library;
    const short = library.shortTitle(name);
    const shown = short ? `${short} (${name})` : name;
    const instead = ask.name === name ? "" : ` in place of the "${ask.name}" you asked for`;
    const request = ask.request ? ` (your request: ${shortened(ask.request, 200)})` : "";
    const user = ask.userAsked ? ` The user had asked you: "${ask.userAsked}".` : "";
    bot.appMessage(arrivalLead(name, changed) + `${instead}${request}.${user} Answer that now: draw it with <show name="${name}">…</show> as its usage says, with one short sentence in the user's language. Do not ask Maintainer for it again.)\n${library.catalog([name])}`);
    bot.appNotice(changed ? `${maker ?? "Maintainer"} changed ${shown} as ${this.nameOf(bot)} asked.` : `${maker ?? "Maintainer"} added ${shown} to your components.`);
  }

  /** The library changed: components bots asked for that are in it now go on their lists (`deliverAskedComponents`). */
  deliverAsked() {
    for (const ask of [...this.asks]) {
      if (ask.changing || !this.deps.library.names.includes(ask.name)) continue;
      const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
      if (!bot) { this.asks = this.asks.filter((other) => other !== ask); continue; }
      if (!this.giveComponent(ask.name, bot)) continue;
      this.asks = this.asks.filter((other) => other !== ask);
      this.arrived(ask.name, ask, bot, "Maintainer");
    }
  }

  /** Maintainer replied (`settleComponentAsks`): a change a bot asked for that landed goes back to it, once its editors are done. */
  settle(record: { role: string; choices?: unknown[]; chosen?: number; answer?: string }) {
    const maintainer = this.maintainer;
    if (!maintainer || (record.role !== "bot" && record.role !== "error")) return;
    if (record.choices?.length && record.chosen === undefined && record.answer === undefined) return;
    if (maintainer.subagentsAtWork) return;
    // A component it just committed may not have been seen yet.
    if (this.deps.rescan) this.deps.rescan();
    else this.deps.library.rescan();
    for (const ask of [...this.asks]) {
      if (!ask.changing || this.deps.library.stampOf(ask.name) === ask.stamp) continue;
      this.asks = this.asks.filter((other) => other !== ask);
      const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
      if (bot) this.arrived(ask.name, ask, bot, "Maintainer", true);
    }
  }

  /** Maintainer's `<component-declined id="…">` (`declineComponentAsk`). */
  decline(rawId: string, rawReason: string) {
    const id = rawId.trim().toLowerCase();
    const ask = this.asks.find((candidate) => candidate.key === id);
    if (!ask) return;
    this.asks = this.asks.filter((other) => other !== ask);
    const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
    if (!bot) return;
    const reason = rawReason.trim();
    const said = reason ? ` Maintainer said: "${shortened(reason, 500)}".` : "";
    const user = ask.userAsked ? ` The user had asked you: "${ask.userAsked}".` : "";
    bot.appMessage(`(App: Maintainer did not add the component "${ask.name}" you asked for${ask.changing ? " (or change it)" : ""}.${said}${user} Tell the user in one or two sentences, in their language, that it is not available and why, then answer their request as well as you can without it. Do not ask Maintainer for it again.)`);
    bot.appNotice((ask.changing ? `Maintainer did not change ${ask.name}:` : `Maintainer did not add ${ask.name}:`) + (reason ? " " + shortened(firstLine(reason), 160) : ""));
  }

  /** The bot a tag names (`componentHolder(named:)`). */
  private holder(name: string): Bot | null {
    const wanted = name.trim().toLowerCase();
    const main = this.deps.mainBot();
    if (wanted === "main bot" || wanted === main.profile.name.toLowerCase()) return main;
    return this.deps.bots().find((bot) => bot.profile.name.toLowerCase() === wanted) ?? null;
  }

  /** Maintainer's `<give-component>` / `<take-component>` (`changeComponentList`). */
  changeList(give: boolean, rawName: string, botName: string) {
    const maintainer = this.maintainer;
    const bot = this.holder(botName);
    if (!bot) { maintainer?.queueNote(`(App: There is no bot called "${botName}"; no component list changed.)`); return; }
    const name = this.deps.library.names.find((candidate) => candidate.toLowerCase() === rawName.toLowerCase()) ?? rawName;
    const shown = this.nameOf(bot);
    if (give) {
      if (!this.deps.library.names.includes(name)) { maintainer?.queueNote(`(App: "${name}" is not in the library, so it was not added to ${shown}'s list.)`); return; }
      if (!this.giveComponent(name, bot)) {
        maintainer?.queueNote(`(App: ${shown} already has ${bot.ownComponentNames.length} / ${COMPONENT_LIMIT} components, so "${name}" was not added. Ask the user which one to remove from ${shown}'s list first.)`);
        return;
      }
      const asked = this.asks.find((ask) => ask.botId === bot.id && ask.name === name) ?? this.asks.find((ask) => ask.botId === bot.id && !ask.changing);
      if (asked) {
        this.asks = this.asks.filter((other) => other !== asked);
        this.arrived(name, asked, bot, "Maintainer");
      } else {
        bot.queueNote(`(App: Maintainer gave you the component "${name}".)`);
      }
    } else if (this.takeComponent(name, bot)) {
      bot.queueNote(`(App: "${name}" was taken off your components; it stays in the shared library.)`);
      this.deliverAsked();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Installs

  /** Fetches a plugin, checks it and asks the user in the main bot's chat before installing it (`proposeInstall`). */
  proposeInstall(rawSource: string) {
    const source = rawSource.trim();
    const main = this.deps.mainBot();
    if (!source || this.installing.has(source)) return;
    this.installing.add(source);
    let proposal: InstallProposal;
    try {
      proposal = fetchPlugin(source, join(this.deps.root, "install-staging"), this.git.git);
    } catch (error) {
      main.appNotice(`Couldn't install "${source}": ${(error as Error).message}`);
      this.installing.delete(source);
      return;
    } finally {
      // (A git clone is synchronous here; the staging folder is removed whatever the answer.)
    }
    this.installing.delete(source);
    if (proposal.problems.length) {
      main.appNotice(`"${title(proposal.manifest)}" failed the checks and was not installed: ${proposal.problems.join("; ")}`);
      rmSync(proposal.work, { recursive: true, force: true });
      return;
    }
    main.appNotice(installSummary(proposal), [{ label: "Install" }, { label: "Don't install" }], (index) => {
      if (index === 0) this.finishInstall(proposal);
      else rmSync(proposal.work, { recursive: true, force: true });
    });
  }

  /** "Install": into the library (replacing one it installed before), committed (`finishInstall`, `PluginRegistry.install`). */
  private finishInstall(proposal: InstallProposal) {
    const main = this.deps.mainBot();
    const plugins = this.deps.plugins();
    const name = proposal.manifest.name;
    const shown = title(proposal.manifest);
    try {
      const existing = plugins?.registry.plugin(name);
      if (existing && !existing.installedFrom) {
        main.appNotice(`"${shown}" could not be installed: The plugin library already has its own "${name}"; it won't be replaced by an outside one.`);
        return;
      }
      this.git.prepare();
      const target = join(this.deps.root, "plugins", name);
      rmSync(target, { recursive: true, force: true });
      cpSync(proposal.folder, target, { recursive: true });
      this.git.run(["add", "-A", "--", name]);
      this.git.run(["commit", "-q", "-m", `Install ${name} ${proposal.manifest.version} (${proposal.source})`, "--", name]);
      plugins?.registry.noteInstalled(name, proposal.source);
      main.appNotice(`Installed: ${shown} ${proposal.manifest.version}. You can turn it off under Plugins (the header's Plugins button).`);
    } catch (error) {
      main.appNotice(`"${shown}" could not be installed: Couldn't put it into the plugin library: ${(error as Error).message}`);
    } finally {
      rmSync(proposal.work, { recursive: true, force: true });
    }
  }

  /** A plugin broke: Maintainer is asked to fix it (`onBroken`). */
  broken(plugin: string, problem: string) {
    this.handTo(`(App: Hot-update check) The plugin "${plugin}" is broken; Botling fell back to the previous version or disabled it for now. Please fix it: ${problem}`);
  }
}
