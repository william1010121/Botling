// The plugin library: <core>/plugins/<name>/ with a package.json each, as 1.x's `PluginRegistry`
// (Plugins.swift). It keeps which plugins are on, their settings and which broke in <core>/plugins.json
// (1.x's format: disabled, settings, failures by fingerprint, installed), and is read again every
// 1.5 s, so an edited plugin reloads without a restart. Secret settings are not in plugins.json: they
// are sealed (secrets.ts).
//
// 2.0 differences: no built-in plugins folder (ccb-latex is bundled into the chat page); a broken web
// part has no "last version that worked" to fall back on, since 2.0 runs third-party web parts only
// in sandboxed panel frames (see core/plugins/index.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { checkPlugin, loadPlugin, title, type JSONValue, type PluginManifest, type PluginPanel } from "./manifest";
import type { SecretStore } from "./secrets";

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
  private reportedProblems: Record<string, string[]> = {};
  private crashes = new Map<string, number[]>();
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

  /** The plugin broke (a program part failed to load, or kept crashing): off until its files change. */
  markFailed(name: string, message: string) {
    if (this.state.failures[name]?.fingerprint === this.fingerprints[name]) return;
    this.state.failures[name] = { message, fingerprint: this.fingerprints[name] ?? "" };
    this.saveState();
    this.rescan(true);
    const shown = this.plugin(name) ? title(this.plugin(name)!.manifest) : name;
    this.onNotice(`Plugin "${shown}" failed and was disabled for now: ${message}`);
    this.onBroken(name, message);
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
  claudeDirectories(): string[] {
    return this.plugins.flatMap((plugin) => (plugin.enabled && !plugin.failure && plugin.manifest.ccb?.claude ? [join(plugin.folder, plugin.manifest.ccb.claude)] : []));
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
