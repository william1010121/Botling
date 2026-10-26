// The plugin library: <core>/plugins/<name>/ with a package.json each, as 1.x's `PluginRegistry`
// (Plugins.swift). It keeps which plugins are on, their settings and which broke in <core>/plugins.json
// (1.x's format: disabled, settings, failures by fingerprint, installed), and is read again every
// 1.5 s, so an edited plugin reloads without a restart. Secret settings are not in plugins.json: they
// are sealed (secrets.ts).
//
// 2.0 differences: no built-in plugins folder (ccb-latex is bundled into the chat page). Since Phase 4a
// web parts run in the chat page again (it has an origin of its own), with 1.x's "last version that
// worked" to fall back on when a new one breaks.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { checkPlugin, loadPlugin, title, type JSONValue, type PluginManifest, type PluginPanel } from "./manifest";
import type { SecretStore } from "./secrets";

/** A plugin's web part as the chat page loads it (`WebPluginSpec`). `styles` are paths in the plugin's folder. */
export interface WebSpec {
  name: string;
  version: string;
  source: string;
  styles: string[];
  settings: Record<string, JSONValue>;
  commands: { id: string; title: string; key?: string }[];
}

/** File types a web part's stylesheet may bring along (fonts, pictures). */
const WEB_FILE_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export interface InstalledPlugin {
  manifest: PluginManifest;
  folder: string;
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
  fingerprint: string;
  settings: Record<string, JSONValue>;
  storageDir: string;
}

interface State {
  disabled: string[];
  settings: Record<string, Record<string, JSONValue>>;
  failures: Record<string, { message: string; fingerprint: string }>;
  installed?: Record<string, string>;
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
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * Swift's `JSONEncoder` with `.prettyPrinted, .sortedKeys`: `"key" : value`, two-space indent, an empty
 * list or object as `[\n\n]`; slashes escaped unless `.withoutEscapingSlashes` (`escapeSlashes: false`).
 */
export function swiftPrettyJSON(value: unknown, { escapeSlashes = true } = {}, indent = ""): string {
  const inner = indent + "  ";
  const options = { escapeSlashes };
  if (Array.isArray(value)) {
    if (!value.length) return "[\n\n" + indent + "]";
    return "[\n" + value.map((item) => inner + swiftPrettyJSON(item, options, inner)).join(",\n") + "\n" + indent + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
    if (!keys.length) return "{\n\n" + indent + "}";
    return "{\n" + keys.map((key) => `${inner}${swiftPrettyJSON(key, options)} : ${swiftPrettyJSON((value as Record<string, unknown>)[key], options, inner)}`).join(",\n") + "\n" + indent + "}";
  }
  const text = JSON.stringify(value);
  return escapeSlashes ? text.replace(/\//g, "\\/") : text;
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
  private reportedProblems: Record<string, string[]> = {};
  private crashes = new Map<string, number[]>();
  /** Web parts the chat page loaded without trouble (1.x's `lastGood`), and what was last handed to it. */
  private lastGood = new Map<string, WebSpec>();
  private lastSent = new Map<string, WebSpec>();
  private scanned = false;

  constructor(readonly library: string, private readonly stateFile: string, readonly secrets: SecretStore) {
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
        name: plugin.manifest.name, version: plugin.manifest.version, main: join(plugin.folder, host),
        fingerprint: this.fingerprints[plugin.manifest.name] ?? "", settings, storageDir: join(dataRoot, plugin.manifest.name),
      }];
    });
  }

  /** The settings a page may see (never secrets: only whether each is set). */
  settingsView(plugin: InstalledPlugin): { key: string; type: string; title: string; options: string[]; value: JSONValue; secret: boolean; set: boolean }[] {
    const values = this.resolvedSettings(plugin);
    return Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {}).map(([key, setting]) => ({
      key, type: setting.type, title: setting.title, options: setting.options ?? [], secret: !!setting.secret,
      value: setting.secret ? null : values[key] ?? null,
      set: setting.secret ? this.secrets.has(plugin.manifest.name, key) : true,
    }));
  }

  /** Claude parts of enabled plugins, for bots' `--plugin-dir`. */
  /** Agent files (`claude/agents/*.md`) of enabled plugins, by file name: the temporary teams (`agentFiles`). */
  agentFiles(): { plugin: string; file: string }[] {
    return this.plugins.flatMap((plugin) => {
      const claude = plugin.manifest.ccb?.claude;
      if (!plugin.enabled || !claude) return [];
      const folder = join(plugin.folder, claude, "agents");
      let names: string[] = [];
      try { names = readdirSync(folder).filter((name) => name.endsWith(".md")).sort(); } catch { /* none */ }
      return names.map((name) => ({ plugin: plugin.manifest.name, file: join(folder, name) }));
    });
  }

  claudeDirectories(): string[] {
    return this.plugins.flatMap((plugin) => (plugin.enabled && !plugin.failure && plugin.manifest.ccb?.claude ? [join(plugin.folder, plugin.manifest.ccb.claude)] : []));
  }

  /**
   * The Claude parts `claudeDirectories()` gives, each with a hash of what its files hold (1.x's
   * `claudeStamp`): a session started with a different stamp has older skills, agents or MCP servers.
   * A file written again with the same bytes, or a change outside the Claude part (package.json, the
   * web part), leaves the stamp as it was: no bot restarts for it.
   */
  claudeStamp(): string[] {
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
      return [`${resolve(plugin.folder, claude)}#${known.hash}`];
    });
  }

  /**
   * The MCP tools of the plugins' Claude parts (`claudeTools`): `mcp__plugin_<name>_<server>` for each server in
   * `<claude>/.mcp.json`, where <name> is its plugin.json name. Bots use them without asking, as in 1.x.
   */
  claudeTools(): string[] {
    return this.plugins.flatMap((plugin) => {
      const claude = plugin.manifest.ccb?.claude;
      if (!plugin.enabled || plugin.failure || !claude) return [];
      const read = (file: string): Record<string, unknown> | null => {
        try { const value = JSON.parse(readFileSync(join(plugin.folder, claude, file), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
      };
      const declared = read(join(".claude-plugin", "plugin.json"))?.name;
      const name = typeof declared === "string" && declared ? declared : plugin.manifest.name;
      const mcp = read(".mcp.json");
      if (!mcp) return [];
      const servers = mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers) ? mcp.mcpServers as Record<string, unknown> : mcp;
      return Object.keys(servers).sort().map((server) => `mcp__plugin_${name}_${server}`);
    });
  }

  /** Secrets that name an `env`, for bots' processes (their MCP servers read them). */
  secretEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue;
      for (const [key, setting] of Object.entries(plugin.manifest.ccb?.contributes?.settings ?? {})) {
        const value = setting.secret && setting.env ? this.secrets.get(plugin.manifest.name, key) : null;
        if (setting.env && value) env[setting.env] = value;
      }
    }
    return env;
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
    let folders: string[] = [];
    try { folders = readdirSync(this.library).filter((name) => !name.startsWith(".")).sort(); } catch { /* no library yet */ }
    for (const name of folders) {
      const folder = join(this.library, name);
      if (!existsSync(join(folder, "package.json"))) continue;
      const loaded = loadPlugin(folder);
      if (loaded.ok) {
        const manifest = loaded.manifest;
        const print = PluginRegistry.fingerprint(folder, manifest);
        prints[manifest.name] = print;
        const failed = this.state.failures[manifest.name];
        const failure = failed && failed.fingerprint === print ? failed.message : null;
        found.set(manifest.name, {
          manifest, folder, failure, enabled: !this.state.disabled.includes(manifest.name) && !failure,
          installedFrom: this.state.installed?.[manifest.name] ?? null,
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
    const sorted = [...found.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0));
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

  /** Checks a folder without adding it (for installs). */
  static check(folder: string): string[] {
    return checkPlugin(folder);
  }
}
