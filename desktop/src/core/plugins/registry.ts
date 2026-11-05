// The plugin library: <core>/plugins/<name>/ with a package.json each, as 1.x's `PluginRegistry`
// (Plugins.swift). It keeps which plugins are on, their settings and which broke in <core>/plugins.json
// (1.x's format: disabled, settings, failures by fingerprint, installed), and is read again every
// 1.5 s, so an edited plugin reloads without a restart. Secret settings are not in plugins.json: they
// are sealed (secrets.ts).
//
// Built-in plugins (step M11: ccb-latex, botling.cards, botling.design) are read from the app's own folder
// first, as 1.x's `builtIns` root: read-only, on until you turn them off, and a plugin of the same name in
// the library replaces one. Since Phase 4a web parts run in the chat page again (it has an origin of its
// own), with 1.x's "last version that worked" to fall back on when a new one breaks.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { checkPlugin, diskFolder, loadPlugin, readManifest, title, type JSONValue, type PluginManifest, type PluginPanel } from "./manifest";
import type { Contribution } from "./contributions";
import type { SecretStore } from "./secrets";
import { swiftPrettyJSON } from "../swift-json";
import { listInspectQueries, runInspect, type InspectContext, type InspectResult } from "./introspect";

/** A plugin's web part as the chat page loads it (`WebPluginSpec`). `styles` are paths in the plugin's folder. */
export interface WebSpec {
  name: string;
  version: string;
  source: string;
  styles: string[];
  settings: Record<string, JSONValue>;
  commands: { id: string; title: string; key?: string }[];
  /** Ships with Botling (a library plugin of the same name that replaced it is not): the chat page lends it its own parts (`ccb.page`). */
  builtIn?: boolean;
}

/** File types a web part's stylesheet may bring along (fonts, pictures). */
const WEB_FILE_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export interface InstalledPlugin {
  manifest: PluginManifest;
  folder: string;
  /** Shipped with Botling (read-only, always approved); a plugin of the same name in the library replaces it. */
  builtIn: boolean;
  enabled: boolean;
  /** Why it was turned off when it broke (until its files change). */
  failure: string | null;
  /** Installed from outside (git, a folder): where from. */
  installedFrom: string | null;
}

/** What the plugin host needs to run one program part (`HostPluginSpec` in Web/host/src/host.ts). */
export interface HostSpec {
  name: string;
  version: string;
  main: string;
  /** The plugin's folder (`api.plugin.dir`; without it, the main module's folder). */
  dir?: string;
  fingerprint: string;
  settings: Record<string, JSONValue>;
  /** Botling's own settings it may read (`settings.app`); the core adds them. */
  app?: Record<string, JSONValue>;
  storageDir: string;
  /** Botling's data folder, for a built-in plugin taking over files the core used to keep there (`api.plugin.appDataDir`). */
  appDataDir?: string;
}

interface State {
  disabled: string[];
  settings: Record<string, Record<string, JSONValue>>;
  failures: Record<string, { message: string; fingerprint: string }>;
  installed?: Record<string, string>;
  /** Keys plugins bound to their own commands (`keybindings.set`; null: no key), over their manifests'. */
  keys?: Record<string, Record<string, string | null>>;
}

const emptyState = (): State => ({ disabled: [], settings: {}, failures: {}, installed: {} });

function readState(file: string): State {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    const state = emptyState();
    if (Array.isArray(value.disabled)) state.disabled = value.disabled.filter((name): name is string => typeof name === "string");
    if (value.settings && typeof value.settings === "object") state.settings = value.settings as State["settings"];
    if (value.failures && typeof value.failures === "object") state.failures = value.failures as State["failures"];
    if (value.installed && typeof value.installed === "object") state.installed = value.installed;
    if (value.keys && typeof value.keys === "object") state.keys = value.keys;
    return state;
  } catch {
    return emptyState();
  }
}

/** Every file in a folder (relative paths, sorted), for a Claude part's fingerprint. */
function filesIn(folder: string, base = folder): string[] {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesIn(path, base) : entry.isFile() ? [relative(base, path).split(sep).join("/")] : [];
  }).sort();
}

export class PluginRegistry {
  plugins: InstalledPlugin[] = [];
  /** Folders that look like plugins but could not be read, with why. */
  problems: Record<string, string[]> = {};
  /** Bumps whenever a plugin's files, its on/off state or its settings change. */
  revision = 0;
  /** A plugin broke or said something: the main bot's chat shows it. */
  onNotice: (text: string) => void = () => {};
  /** A plugin broke (its check failed, it threw on load): Maintainer should fix it. */
  onBroken: (plugin: string, problem: string) => void = () => {};
  /** A plugin's version changed on disk, with the version it had. */
  onUpdated: (plugin: InstalledPlugin, from: string) => void = () => {};
  /** Anything that matters changed (`revision` moved). */
  onChanged: () => void = () => {};

  private state: State;
  private fingerprints: Record<string, string> = {};
  /** Each Claude part's content hash, by the fingerprint it was taken at (`claudeContents`). */
  private claudeContents = new Map<string, { fingerprint: string; hash: string }>();
  /** Each plugin's skill folders (`skillRoots`), by the fingerprint they were read at. */
  private skillFolders = new Map<string, { fingerprint: string; roots: { root: string; claude: boolean }[] }>();
  private reportedProblems: Record<string, string[]> = {};
  private crashes = new Map<string, number[]>();
  /** Web parts the chat page loaded without trouble (1.x's `lastGood`), and what was last handed to it. */
  private lastGood = new Map<string, WebSpec>();
  private lastSent = new Map<string, WebSpec>();
  private scanned = false;

  /** `builtIns`: the folder of the plugins shipped with the app (none in some tests). */
  constructor(readonly library: string, private readonly stateFile: string, readonly secrets: SecretStore, readonly builtIns: string | null = null) {
    this.state = readState(stateFile);
    this.rescan();
  }

  plugin(name: string) {
    return this.plugins.find((plugin) => plugin.manifest.name === name);
  }

  private saveState() {
    writeFileAtomic(this.stateFile, swiftPrettyJSON(this.state));
  }

  private bump() {
    this.revision++;
    this.onChanged();
  }

  // ------------------------------------------------------------------------------------------
  // Changing

  setEnabled(name: string, enabled: boolean) {
    this.state.disabled = this.state.disabled.filter((other) => other !== name);
    if (!enabled) this.state.disabled.push(name);
    // Turning it back on gives a broken plugin another try.
    if (enabled) delete this.state.failures[name];
    this.saveState();
    this.rescan(true);
  }

  setting(plugin: string, key: string): JSONValue | null {
    return this.state.settings[plugin]?.[key] ?? this.plugin(plugin)?.manifest.ccb?.contributes?.settings?.[key]?.default ?? null;
  }

  set(plugin: string, key: string, value: JSONValue) {
    (this.state.settings[plugin] ??= {})[key] = value;
    this.saveState();
    this.bump();
  }

  /** A plugin binds one of its commands to `key` (null: none), in place of its manifest's (`keybindings.set`). */
  setCommandKey(plugin: string, command: string, key: string | null) {
    (this.state.keys ??= {})[plugin] = { ...this.state.keys[plugin], [command]: key };
    this.saveState();
    this.bump();
  }

  /** The keys plugins set for their own commands, by plugin then command (null: no key). */
  commandKeyOverrides(): Record<string, Record<string, string | null>> {
    return this.state.keys ?? {};
  }

  async setSecret(plugin: string, key: string, value: string | null) {
    await this.secrets.set(plugin, key, value);
    this.bump();
  }

  /** The plugin broke (a program part failed to load, or kept crashing; its web part threw): off until its files change. */
  markFailed(name: string, message: string) {
    if (this.state.failures[name]?.fingerprint === this.fingerprints[name]) return;
    this.state.failures[name] = { message, fingerprint: this.fingerprints[name] ?? "" };
    this.saveState();
    this.rescan(true);
    const shown = this.plugin(name) ? title(this.plugin(name)!.manifest) : name;
    if (this.usingPrevious(name)) this.onNotice(`Plugin "${shown}": the new version failed; using the previous version and handed it to Maintainer: ${message}`);
    else this.onNotice(`Plugin "${shown}" failed and was disabled for now: ${message}`);
    this.onBroken(name, message);
  }

  /** The chat page loaded this web part without trouble: the one to fall back to (`markLoaded`). */
  markLoaded(name: string) {
    const spec = this.lastSent.get(name);
    if (spec) this.lastGood.set(name, spec);
  }

  /** A broken plugin (not turned off by you) whose last good web part still runs. */
  private usingPrevious(name: string): boolean {
    const plugin = this.plugin(name);
    return !!plugin?.failure && !this.state.disabled.includes(name) && this.lastGood.has(name);
  }

  /**
   * Every web part the chat page runs (`webSpecs`): those of plugins that are on, and for a broken one
   * you did not turn off, the last version that loaded.
   */
  webSpecs(): WebSpec[] {
    return this.plugins.flatMap((plugin): WebSpec[] => {
      const name = plugin.manifest.name;
      if (this.state.disabled.includes(name)) return [];
      if (plugin.failure) {
        const previous = this.lastGood.get(name);
        return previous ? [{ ...previous, settings: this.resolvedSettings(plugin) }] : [];
      }
      const web = plugin.manifest.ccb?.web;
      if (!web) return [];
      let source: string;
      try { source = readFileSync(join(plugin.folder, web), "utf8"); } catch { return []; }
      const spec: WebSpec = {
        name, version: plugin.manifest.version, source, styles: [...(plugin.manifest.ccb?.styles ?? [])],
        settings: this.resolvedSettings(plugin), commands: (plugin.manifest.ccb?.contributes?.commands ?? []).map((command) => ({ ...command })),
        ...(plugin.builtIn ? { builtIn: true } : {}),
      };
      this.lastSent.set(name, spec);
      return [spec];
    });
  }

  /**
   * One of a web part's files for the chat page: a stylesheet its manifest names, or a font or picture
   * in the folder of one (what a stylesheet loads relative to itself). Never anything else in the folder.
   */
  webFile(name: string, path: string): { path: string; type: string } | null {
    const plugin = this.plugin(name);
    if (!plugin || this.state.disabled.includes(name)) return null;
    const styles = (plugin.manifest.ccb?.styles ?? []).map((style) => normalize(style));
    const wanted = normalize(path);
    if (wanted.startsWith("..") || wanted.startsWith(sep) || wanted.split(sep).some((part) => part.startsWith("."))) return null;
    const type = WEB_FILE_TYPES[extname(wanted).toLowerCase()];
    if (!type) return null;
    const listed = styles.includes(wanted);
    const beside = styles.some((style) => {
      const folder = dirname(style);
      return (folder === "." || wanted.startsWith(folder + sep)) && extname(wanted).toLowerCase() !== ".css";
    });
    if (!listed && !beside) return null;
    try {
      const real = realpathSync(join(plugin.folder, wanted));
      const root = realpathSync(plugin.folder);
      if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
      return { path: real, type };
    } catch {
      return null;
    }
  }

  /** A program part threw or brought the host down: the third time in 10 minutes it is turned off; a load failure at once. */
  recordHostFailure(name: string, message: string, fatal = false, now = Date.now()) {
    if (!this.plugin(name)) return;
    const recent = [...(this.crashes.get(name) ?? []).filter((at) => now - at < 600_000), now];
    this.crashes.set(name, recent);
    if (fatal || recent.length >= 3) {
      this.crashes.delete(name);
      this.markFailed(name, message);
    }
  }

  /** A fetched plugin goes into the library (replacing one of the same name it installed before). */
  noteInstalled(name: string, source: string) {
    (this.state.installed ??= {})[name] = source;
    delete this.state.failures[name];
    this.saveState();
    this.rescan(true);
  }

  // ------------------------------------------------------------------------------------------
  // Reading

  private resolvedSettings(plugin: InstalledPlugin): Record<string, JSONValue> {
    const settings: Record<string, JSONValue> = {};
    for (const [key, setting] of Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {})) {
      if (setting.secret) continue;
      settings[key] = this.state.settings[plugin.manifest.name]?.[key] ?? setting.default ?? null;
    }
    return settings;
  }

  /** Every enabled plugin's program part, for the plugin host; each keeps data in `<dataRoot>/<name>/`. */
  hostSpecs(dataRoot: string): HostSpec[] {
    return this.plugins.flatMap((plugin) => {
      const host = plugin.manifest.ccb?.host;
      if (!plugin.enabled || plugin.failure || !host) return [];
      const settings = this.resolvedSettings(plugin);
      // The program part (never a page) gets the secrets too.
      for (const [key, setting] of Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {})) {
        if (setting.secret) settings[key] = this.secrets.get(plugin.manifest.name, key);
      }
      return [{
        name: plugin.manifest.name, version: plugin.manifest.version, main: join(plugin.folder, host), dir: plugin.folder,
        fingerprint: this.fingerprints[plugin.manifest.name] ?? "", settings, storageDir: join(dataRoot, plugin.manifest.name),
        ...(plugin.builtIn ? { appDataDir: dirname(dataRoot) } : {}),
      }];
    });
  }

  /** The settings a page may see (never secrets: only whether each is set). */
  settingsView(plugin: InstalledPlugin): { key: string; type: string; title: string; options: string[]; value: JSONValue; secret: boolean; set: boolean; hidden?: true; default?: boolean | number | string | null }[] {
    const values = this.resolvedSettings(plugin);
    return Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {}).map(([key, setting]) => ({
      key, type: setting.type, title: setting.title, options: setting.options ?? [], secret: !!setting.secret,
      value: setting.secret ? null : values[key] ?? null,
      set: setting.secret ? this.secrets.has(plugin.manifest.name, key) : true,
      ...(setting.hidden ? { hidden: true as const } : {}),
      ...(!setting.secret && setting.default !== undefined && (setting.default === null || typeof setting.default !== "object") ? { default: setting.default as boolean | number | string | null } : {}),
    }));
  }

  /**
   * The Claude parts (`ccb.claude`, a Claude Code plugin folder) of enabled plugins, each with a hash of what its files hold
   * (1.x's `claudeStamp`: a session started with a different hash has older skills, agents or MCP servers; a file written
   * again with the same bytes, or a change outside the Claude part, leaves it as it was) and its MCP tools
   * (`mcp__plugin_<name>_<server>` for each server in `<claude>/.mcp.json`, <name> being its plugin.json name; bots use them
   * without asking, as in 1.x). The one reading `agentContributions()` (agent-contributions.ts) builds on.
   */
  claudeParts(): { plugin: string; dir: string; hash: string; mcpTools: string[] }[] {
    return this.plugins.flatMap((plugin) => {
      const claude = plugin.manifest.ccb?.claude;
      if (!plugin.enabled || plugin.failure || !claude) return [];
      const print = this.fingerprints[plugin.manifest.name] ?? "";
      let known = this.claudeContents.get(plugin.manifest.name);
      if (!known || known.fingerprint !== print) {
        const folder = join(plugin.folder, claude);
        const hasher = createHash("sha256");
        for (const file of filesIn(folder)) {
          hasher.update(`${claude}/${file}`).update("\0");
          try { hasher.update(readFileSync(join(folder, file))); } catch { /* gone meanwhile */ }
          hasher.update("\0");
        }
        known = { fingerprint: print, hash: hasher.digest("hex") };
        this.claudeContents.set(plugin.manifest.name, known);
      }
      const read = (file: string): Record<string, unknown> | null => {
        try { const value = JSON.parse(readFileSync(join(plugin.folder, claude, file), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
      };
      const declared = read(join(".claude-plugin", "plugin.json"))?.name;
      const name = typeof declared === "string" && declared ? declared : plugin.manifest.name;
      const mcp = read(".mcp.json");
      const servers = !mcp ? null : mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers) ? mcp.mcpServers as Record<string, unknown> : mcp;
      return [{ plugin: plugin.manifest.name, dir: join(plugin.folder, claude), hash: known.hash, mcpTools: servers ? Object.keys(servers).sort().map((server) => `mcp__plugin_${name}_${server}`) : [] }];
    });
  }

  /**
   * The folders that hold the skills (folders with a SKILL.md) of enabled plugins: a Claude part's `skills/` and
   * `contributes.skills`, those that are there, in the plugins' order. `claude`: inside the Claude part (`ccb.claude`), which
   * Claude already loads with --plugin-dir. Read again only when a plugin's fingerprint (its package.json among it) changes,
   * since it is asked for on every message (agentStamp): a folder counts once it held a skill when it was read; skills added
   * to a folder already listed need nothing new (engines read the folder itself).
   */
  skillRoots(): { plugin: string; root: string; claude: boolean }[] {
    return this.plugins.flatMap((plugin) => {
      if (!plugin.enabled || plugin.failure) return [];
      const print = this.fingerprints[plugin.manifest.name] ?? "";
      let known = this.skillFolders.get(plugin.manifest.name);
      if (!known || known.fingerprint !== print) {
        let roots: { root: string; claude: boolean }[] = [];
        try {
          const read = readManifest(JSON.parse(readFileSync(join(plugin.folder, "package.json"), "utf8")), diskFolder(plugin.folder));
          for (const part of read.contributions) {
            if (part.kind !== "agent") continue;
            const claude = part.claude;
            const dirs = new Set(part.skills.map((skill) => dirname(skill.dir)));
            for (const dir of dirs) roots.push({ root: join(plugin.folder, dir), claude: !!claude && (dir === claude || dir.startsWith(`${claude}/`)) });
          }
        } catch { roots = []; }
        known = { fingerprint: print, roots };
        this.skillFolders.set(plugin.manifest.name, known);
      }
      return known.roots.map((entry) => ({ plugin: plugin.manifest.name, ...entry }));
    });
  }

  /** The secrets of each enabled plugin that name an `env` (their MCP servers read them), by plugin. */
  secretEnvironments(): { plugin: string; env: Record<string, string> }[] {
    const out: { plugin: string; env: Record<string, string> }[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue;
      const env: Record<string, string> = {};
      for (const [key, setting] of Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {})) {
        const value = setting.secret && setting.env ? this.secrets.get(plugin.manifest.name, key) : null;
        if (setting.env && value) env[setting.env] = value;
      }
      if (Object.keys(env).length) out.push({ plugin: plugin.manifest.name, env });
    }
    return out;
  }

  /** Panels from enabled plugins with a web part, in order. */
  panels(): { plugin: InstalledPlugin; panel: PluginPanel }[] {
    return this.plugins.flatMap((plugin) => (plugin.enabled && !plugin.failure && plugin.manifest.ccb?.web ? (plugin.manifest.ccb.contributes?.panels ?? []).map((panel) => ({ plugin, panel })) : []));
  }

  /** A plugin's web part, as module text (for its sandboxed panel frame), with its non-secret settings. */
  webPart(name: string): { source: string; settings: Record<string, JSONValue> } | null {
    const plugin = this.plugin(name);
    const web = plugin?.manifest.ccb?.web;
    if (!plugin || !plugin.enabled || plugin.failure || !web) return null;
    try {
      return { source: readFileSync(join(plugin.folder, web), "utf8"), settings: this.resolvedSettings(plugin) };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Watching

  /** What decides whether a plugin reloads: its manifest and the files it names (`fingerprint`). */
  static fingerprint(folder: string, manifest: PluginManifest): string {
    const files = ["package.json", manifest.ccb?.web, manifest.ccb?.host, ...(manifest.ccb?.styles ?? [])].filter((file): file is string => !!file);
    if (manifest.ccb?.claude) files.push(...filesIn(join(folder, manifest.ccb.claude)).map((file) => `${manifest.ccb!.claude}/${file}`));
    return files.map((file) => {
      try {
        const stat = statSync(join(folder, file));
        return `${file}:${stat.mtimeMs / 1000}:${stat.size}`;
      } catch {
        return `${file}:0:-1`;
      }
    }).join("|");
  }

  /** Reads every plugin again; true (and `onChanged`) when anything that matters changed. */
  rescan(force = false): boolean {
    const found = new Map<string, InstalledPlugin>();
    const problems: Record<string, string[]> = {};
    const prints: Record<string, string> = {};
    const folders: { name: string; folder: string; builtIn: boolean }[] = [];
    for (const [root, builtIn] of [[this.builtIns, true], [this.library, false]] as const) {
      if (!root) continue;
      try { folders.push(...readdirSync(root).filter((name) => !name.startsWith(".")).sort().map((name) => ({ name, folder: join(root, name), builtIn }))); } catch { /* no library yet */ }
    }
    for (const { name, folder, builtIn } of folders) {
      if (!existsSync(join(folder, "package.json"))) continue;
      const loaded = loadPlugin(folder);
      if (loaded.ok) {
        const manifest = loaded.manifest;
        const print = PluginRegistry.fingerprint(folder, manifest);
        prints[manifest.name] = print;
        const failed = this.state.failures[manifest.name];
        const failure = failed && failed.fingerprint === print ? failed.message : null;
        found.set(manifest.name, {
          manifest, folder, builtIn, failure, enabled: !this.state.disabled.includes(manifest.name) && !failure,
          installedFrom: builtIn ? null : this.state.installed?.[manifest.name] ?? null,
        });
        delete this.reportedProblems[name];
      } else {
        problems[name] = loaded.problems;
        // A plugin that was fine before keeps running its last version.
        const old = this.plugins.find((plugin) => plugin.folder === folder);
        if (old) {
          found.set(old.manifest.name, old);
          prints[old.manifest.name] = this.fingerprints[old.manifest.name] ?? "";
        }
        if (JSON.stringify(this.reportedProblems[name]) !== JSON.stringify(loaded.problems)) {
          this.reportedProblems[name] = loaded.problems;
          if (this.scanned) this.onBroken(name, "Check failed: " + loaded.problems.join("; "));
        }
      }
    }
    // Built-in plugins first, then the library's, each by name.
    const sorted = [...found.values()].sort((a, b) => Number(a.builtIn) !== Number(b.builtIn) ? Number(b.builtIn) - Number(a.builtIn)
      : a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0);
    const changed = force || JSON.stringify(prints) !== JSON.stringify(this.fingerprints) || JSON.stringify(sorted) !== JSON.stringify(this.plugins)
      || JSON.stringify(problems) !== JSON.stringify(this.problems);
    for (const plugin of sorted) {
      const old = this.plugins.find((candidate) => candidate.manifest.name === plugin.manifest.name);
      if (old && old.manifest.version !== plugin.manifest.version) this.onUpdated(plugin, old.manifest.version);
    }
    this.fingerprints = prints;
    this.plugins = sorted;
    this.problems = problems;
    this.scanned = true;
    if (changed) this.bump();
    return changed;
  }

  /** Component folders of enabled plugins (`componentFolders`). */
  componentFolders(): string[] {
    return this.plugins.flatMap((plugin) => (plugin.enabled && plugin.manifest.ccb?.contributes?.components ? [join(plugin.folder, plugin.manifest.ccb.contributes.components)] : []));
  }

  /** Component folders of enabled built-in plugins (botling.cards'): the component library reads them after the library's own. */
  builtInComponentFolders(): string[] {
    return this.plugins.flatMap((plugin) => (plugin.builtIn && plugin.enabled && plugin.manifest.ccb?.contributes?.components ? [join(plugin.folder, plugin.manifest.ccb.contributes.components)] : []));
  }

  /**
   * What enabled plugins contribute, read again from each package.json (`readManifest`: `botling`, or
   * `ccb` as it works today). Nothing acts on it yet; it is the one source later steps move onto.
   */
  contributions(): Contribution[] {
    return this.plugins.flatMap((plugin) => {
      if (!plugin.enabled || plugin.failure) return [];
      try { return readManifest(JSON.parse(readFileSync(join(plugin.folder, "package.json"), "utf8")), diskFolder(plugin.folder)).contributions; } catch { return []; }
    });
  }

  /**
   * What enabled plugins contribute, with the keys their program parts set for their own commands
   * (`keybindings.set`, including `null` unbinds) in place of their manifests'.
   */
  effectiveContributions(): Contribution[] {
    const set = this.commandKeyOverrides();
    const list = this.contributions();
    const declared = new Set(list.flatMap((entry) => (entry.kind === "command" ? [`${entry.plugin}\u0000${entry.id}`] : [])));
    const kept = list.filter((entry) => !(entry.kind === "keybinding" && set[entry.plugin] && Object.hasOwn(set[entry.plugin]!, entry.command)));
    for (const [plugin, keys] of Object.entries(set)) {
      for (const [command, key] of Object.entries(keys)) {
        if (key && declared.has(`${plugin}\u0000${command}`)) kept.push({ kind: "keybinding", plugin, command, key });
      }
    }
    return kept;
  }

  /** The read-only queries the Maintainer may ask (ADR-006 M2), with their input schemas. */
  inspectQueries() {
    return listInspectQueries();
  }

  /** Runs one read-only introspection query (introspect.ts): validated input, JSON out, nothing written, no secrets. */
  inspect(query: string, input: unknown, context: InspectContext = { themeCss: null }): InspectResult {
    return runInspect(this, query, input, context);
  }

  /** Checks a folder without adding it (for installs). */
  static check(folder: string): string[] {
    return checkPlugin(folder);
  }
}
