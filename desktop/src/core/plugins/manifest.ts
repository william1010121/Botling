// A plugin's package.json (npm's format with a `ccb` field, like a VS Code extension) and the check
// 1.x runs on it (`PluginRegistry.check`, `ccb plugin check` without the browser parts), ported from
// Plugins.swift: the same problems, worded the same, and the same npm semver ranges for `engines.ccb`.
// `readManifest` is the 3.x reading (plugin-platform.md §3.1): the `botling` field or the older `ccb`
// one, as one shape with its contributions (contributions.ts). Loading still goes by `ccb` alone.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { legacyKey } from "../../contract/shortcuts";
import { insidePlugin, readContributions, type Contribution, type FolderView } from "./contributions";

export type { FolderView } from "./contributions";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface PluginSetting {
  /** boolean, enum, string or number. */
  type: string;
  default?: JSONValue;
  title: string;
  options?: string[];
  /** Kept sealed (Electron safeStorage), never shown or sent to a page. */
  secret?: boolean;
  /** For a secret: the environment variable bots get it in (MCP servers read it). */
  env?: string;
  /** Set somewhere else in Botling (a built-in plugin's settings on the Settings page), not in the Plugins page. */
  hidden?: boolean;
}

export interface PluginCommand { id: string; title: string; key?: string }
export interface PluginPanel { id: string; title: string; icon?: string }

export interface PluginManifest {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  license?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  ccb?: {
    permissions?: string[];
    /** The web part's bundled ES module. */
    web?: string;
    /** The program part, run in the plugin host. */
    host?: string;
    styles?: string[];
    /** A Claude Code plugin folder handed to bots with --plugin-dir. */
    claude?: string;
    contributes?: {
      commands?: PluginCommand[];
      settings?: Record<string, PluginSetting>;
      /** A folder of components (`<name>/template.html` and `about.md`). */
      components?: string;
      /** Pages drawn by the web part (`ccb.panels.register`). */
      panels?: PluginPanel[];
    };
  };
}

export const title = (manifest: PluginManifest) => manifest.displayName ?? manifest.name;

/** What a plugin may ask for in `ccb.permissions` (`PluginPermission`), with what the install question says it allows. */
export const PERMISSIONS: Record<string, string> = {
  composer: "read and change what you type in the input box",
  messages: "read the conversation",
  network: "connect to the internet",
  files: "read and write files on your computer",
  exec: "run programs on your computer",
  bots: "talk to bots on your behalf and make new ones",
  claude: "give the bots new tools",
  sessions: "decide the folder a bot's session works in (built-in plugins only)",
  routines: "see a bot's routines and pause, resume or cancel them (built-in plugins only)",
  cards: "read the components a chat shows and run their commands once allowed, and keep what the chat page draws (built-in plugins only)",
  app: "install a new build of Botling and restart it, take a picture of its window (built-in plugins only)",
};
const PERMISSION_NAMES = Object.keys(PERMISSIONS);

/** The Botling plugin API version plugins are written against (`PluginRegistry.apiVersion`). */
export const API_VERSION = { major: 2, minor: 0 } as const;
export const ENGINE_RANGE = `^${API_VERSION.major}.${API_VERSION.minor}.0`;

// ---------------------------------------------------------------------------------------------
// Decoding as Swift's JSONDecoder would: wrong types fail with where.

class DecodeError extends Error {}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function decodeManifest(value: unknown): PluginManifest {
  const at = (path: string[]) => path.join(".");
  const need = (object: Record<string, unknown>, key: string, path: string[]): unknown => {
    if (!(key in object) || object[key] === null) throw new DecodeError(`missing ${at([...path, key])}`);
    return object[key];
  };
  const string = (value: unknown, path: string[]) => { if (typeof value !== "string") throw new DecodeError(`${at(path)} has the wrong type`); return value; };
  const optString = (object: Record<string, unknown>, key: string, path: string[]) => (object[key] === undefined || object[key] === null ? undefined : string(object[key], [...path, key]));
  const strings = (value: unknown, path: string[]) => { if (!Array.isArray(value)) throw new DecodeError(`${at(path)} has the wrong type`); return value.map((item, index) => string(item, [...path, String(index)])); };
  const dict = (value: unknown, path: string[]) => { if (!isObject(value)) throw new DecodeError(`${at(path)} has the wrong type`); return value; };
  if (!isObject(value)) throw new DecodeError("The given data was not a JSON object.");
  const manifest: PluginManifest = { name: string(need(value, "name", []), ["name"]), version: string(need(value, "version", []), ["version"]) };
  for (const key of ["displayName", "description", "license"] as const) { const v = optString(value, key, []); if (v !== undefined) manifest[key] = v; }
  for (const key of ["engines", "scripts"] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    const object = dict(value[key], [key]);
    manifest[key] = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, string(v, [key, k])]));
  }
  if (value.ccb !== undefined && value.ccb !== null) {
    const ccb = dict(value.ccb, ["ccb"]);
    const out: NonNullable<PluginManifest["ccb"]> = {};
    if (ccb.permissions != null) out.permissions = strings(ccb.permissions, ["ccb", "permissions"]);
    for (const key of ["web", "host", "claude"] as const) { const v = optString(ccb, key, ["ccb"]); if (v !== undefined) out[key] = v; }
    if (ccb.styles != null) out.styles = strings(ccb.styles, ["ccb", "styles"]);
    if (ccb.contributes != null) {
      const c = dict(ccb.contributes, ["ccb", "contributes"]);
      const contributes: NonNullable<NonNullable<PluginManifest["ccb"]>["contributes"]> = {};
      const path = ["ccb", "contributes"];
      if (c.commands != null) {
        if (!Array.isArray(c.commands)) throw new DecodeError(`${at([...path, "commands"])} has the wrong type`);
        contributes.commands = c.commands.map((item, index) => {
          const p = [...path, "commands", String(index)];
          const command = dict(item, p);
          const out: PluginCommand = { id: string(need(command, "id", p), [...p, "id"]), title: string(need(command, "title", p), [...p, "title"]) };
          const key = optString(command, "key", p);
          if (key !== undefined) out.key = key;
          return out;
        });
      }
      if (c.settings != null) {
        const settings = dict(c.settings, [...path, "settings"]);
        contributes.settings = {};
        for (const [name, raw] of Object.entries(settings)) {
          const p = [...path, "settings", name];
          const setting = dict(raw, p);
          const out: PluginSetting = { type: string(need(setting, "type", p), [...p, "type"]), title: string(need(setting, "title", p), [...p, "title"]) };
          if (setting.default !== undefined && setting.default !== null) out.default = setting.default as JSONValue;
          if (setting.options != null) out.options = strings(setting.options, [...p, "options"]);
          if (setting.secret != null) { if (typeof setting.secret !== "boolean") throw new DecodeError(`${at([...p, "secret"])} has the wrong type`); out.secret = setting.secret; }
          const env = optString(setting, "env", p);
          if (env !== undefined) out.env = env;
          if (setting.hidden != null) { if (typeof setting.hidden !== "boolean") throw new DecodeError(`${at([...p, "hidden"])} has the wrong type`); out.hidden = setting.hidden; }
          contributes.settings[name] = out;
        }
      }
      const components = optString(c, "components", path);
      if (components !== undefined) contributes.components = components;
      if (c.panels != null) {
        if (!Array.isArray(c.panels)) throw new DecodeError(`${at([...path, "panels"])} has the wrong type`);
        contributes.panels = c.panels.map((item, index) => {
          const p = [...path, "panels", String(index)];
          const panel = dict(item, p);
          const out: PluginPanel = { id: string(need(panel, "id", p), [...p, "id"]), title: string(need(panel, "title", p), [...p, "title"]) };
          const icon = optString(panel, "icon", p);
          if (icon !== undefined) out.icon = icon;
          return out;
        });
      }
      out.contributes = contributes;
    }
    manifest.ccb = out;
  }
  return manifest;
}

/** Reads and checks a plugin folder: its manifest, or the problems (`PluginRegistry.load`). */
export function loadPlugin(folder: string): { ok: true; manifest: PluginManifest } | { ok: false; problems: string[] } {
  const problems = checkPlugin(folder);
  if (problems.length) return { ok: false, problems };
  try {
    return { ok: true, manifest: decodeManifest(JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))) };
  } catch {
    return { ok: false, problems: ["package.json could not be read."] };
  }
}

const inside = (path: string) => !path.startsWith("/") && !path.split("/").includes("..");

/** Pre-install static gate (ADR-006 M6): the largest an image file in a plugin folder may be. */
export const MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|ico|icns|bmp)$/i;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const WALK_LIMIT = 5_000;

/** Links that leave the plugin folder and oversized images, found by walking it (no node_modules or .git). */
function staticGate(folder: string, add: (code: CheckCode, message: string) => void): void {
  let root: string;
  try { root = realpathSync(folder); } catch { return; }
  const escapes = (real: string) => { const rel = relative(root, real); return rel.startsWith("..") || isAbsolute(rel); };
  let seen = 0;
  const walk = (dir: string, shown: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (++seen > WALK_LIMIT) return;
      const path = join(dir, name);
      const label = shown ? `${shown}/${name}` : name;
      let info;
      try { info = lstatSync(path); } catch { continue; }
      if (info.isSymbolicLink()) {
        let real: string;
        try { real = realpathSync(path); } catch { add("LINK_OUTSIDE_FOLDER", `"${label}" is a link that cannot be followed.`); continue; }
        if (escapes(real)) { add("LINK_OUTSIDE_FOLDER", `"${label}" is a link that points outside the plugin folder.`); continue; }
        info = statSync(path);
      }
      if (info.isDirectory()) { if (!SKIPPED_DIRS.has(name)) walk(path, label); continue; }
      if (info.isFile() && IMAGE_FILE.test(name) && info.size > MAX_IMAGE_BYTES) {
        add("ICON_TOO_LARGE", `Image "${label}" is ${Math.round(info.size / 1024)} KB; the limit is ${Math.round(MAX_IMAGE_BYTES / 1024)} KB.`);
      }
    }
  };
  walk(root, "");
}

/**
 * Every way `checkPlugin` can fail, with the one next action that fixes it. The codes are a contract: the
 * Maintainer's repair loop (and UI hints) go by them, so a code is never renamed or reused (test/unit/plugins.test.ts
 * locks the table). Add new codes at the end.
 */
export const CHECK_NEXT_STEPS = {
  MANIFEST_NOT_FOUND: "Create package.json in the plugin folder with name, version, engines.ccb and a ccb field (see PLUGINS.md).",
  MANIFEST_MALFORMED: "Fix package.json so it is valid JSON with the fields PLUGINS.md describes, then run the check again.",
  NAME_INVALID: "Rename the plugin in package.json to lowercase letters, digits, - . _ (and rename its folder to match).",
  VERSION_INVALID: "Set version in package.json to a semver such as 1.0.0.",
  ENGINE_MISSING: `Add \"engines\": { \"ccb\": \"${ENGINE_RANGE}\" } to package.json.`,
  ENGINE_INCOMPATIBLE: `Set engines.ccb in package.json to a range this Botling satisfies, for example \"${ENGINE_RANGE}\".`,
  CCB_MISSING: "Add a ccb field to package.json naming the parts of the plugin (web, host, claude, contributes), see PLUGINS.md.",
  PATH_OUTSIDE_FOLDER: "Change that path in package.json to a relative path inside the plugin folder (no leading / and no ..).",
  PATH_MISSING: "Create the file at that path (for a bundled part, run the esbuild step) or correct the path in package.json.",
  CLAUDE_PLUGIN_JSON_MISSING: "Add .claude-plugin/plugin.json inside the Claude part's folder (see PLUGINS.md for its shape).",
  STYLE_MISSING: "Create the stylesheet or remove it from ccb.styles; the path must stay inside the plugin folder.",
  PERMISSION_UNKNOWN: "Remove the permission or replace it with one from the allowed list in the message.",
  COMMAND_DUPLICATE: "Give each command in ccb.contributes.commands its own unique id.",
  SHORTCUT_UNREADABLE: "Write the shortcut as modifiers joined by + and one key, for example cmd+shift+l.",
  PANEL_NEEDS_WEB: "Add ccb.web (the bundle that draws panels) or remove the panel from ccb.contributes.panels.",
  SETTING_ENV_INVALID: "Rename the setting's env to uppercase letters, digits and underscores, for example MY_TOKEN.",
  SETTING_ENUM_NO_OPTIONS: "Give the enum setting a non-empty options list.",
  SETTING_DEFAULT_INVALID: "Make the setting's default match its type (and be one of options for an enum), or remove the default.",
  SETTING_TYPE_INVALID: "Set the setting's type to boolean, enum, string or number.",
  LINK_OUTSIDE_FOLDER: "Replace that link with a real copy of the file inside the plugin folder (a symlink must not point outside it).",
  ICON_TOO_LARGE: `Shrink that image below ${Math.round(MAX_IMAGE_BYTES / 1024)} KB (export a smaller size or use SVG) or remove it; a plugin's icons should be small.`,
} as const;

export type CheckCode = keyof typeof CHECK_NEXT_STEPS;

/** One problem from the check: a stable code, the readable message and what to do about it. */
export interface PluginIssue { code: CheckCode; message: string; nextStep: string }

/** The structured problems with a plugin folder; none: it may load. */
export function checkPluginIssues(folder: string): PluginIssue[] {
  const issues: PluginIssue[] = [];
  const add = (code: CheckCode, message: string) => { issues.push({ code, message, nextStep: CHECK_NEXT_STEPS[code] }); };
  let text: string;
  try { text = readFileSync(join(folder, "package.json"), "utf8"); } catch { add("MANIFEST_NOT_FOUND", "package.json not found."); return issues; }
  let manifest: PluginManifest;
  try {
    manifest = decodeManifest(JSON.parse(text));
  } catch (error) {
    const message = error instanceof DecodeError ? error.message : "The given data was not valid JSON.";
    add("MANIFEST_MALFORMED", `package.json is malformed: ${message}`);
    return issues;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) add("NAME_INVALID", `name "${manifest.name}" may only use lowercase letters, digits, - . _.`);
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) add("VERSION_INVALID", `version "${manifest.version}" must be semver, for example 1.0.0.`);
  const range = manifest.engines?.ccb;
  if (range === undefined) {
    add("ENGINE_MISSING", `engines.ccb is missing (for example "${ENGINE_RANGE}").`);
    return issues;
  }
  if (!compatible(range)) add("ENGINE_INCOMPATIBLE", `engines.ccb "${range}" is not compatible with this Botling (${API_VERSION.major}.${API_VERSION.minor}).`);
  const ccb = manifest.ccb;
  if (!ccb) {
    add("CCB_MISSING", "The ccb field is missing.");
    return issues;
  }
  for (const [label, path] of [["web", ccb.web], ["host", ccb.host], ["claude", ccb.claude], ["contributes.components", ccb.contributes?.components]] as const) {
    if (path === undefined) continue;
    if (!inside(path)) add("PATH_OUTSIDE_FOLDER", `${label} "${path}" must be a relative path inside the plugin folder.`);
    else if (!existsSync(join(folder, path))) add("PATH_MISSING", `${label} points to "${path}", which does not exist.`);
  }
  if (ccb.claude !== undefined && !existsSync(join(folder, ccb.claude, ".claude-plugin", "plugin.json"))) {
    add("CLAUDE_PLUGIN_JSON_MISSING", `The Claude part "${ccb.claude}" must contain .claude-plugin/plugin.json.`);
  }
  for (const style of ccb.styles ?? []) if (!inside(style) || !existsSync(join(folder, style))) add("STYLE_MISSING", `"${style}" in styles does not exist.`);
  for (const permission of ccb.permissions ?? []) {
    if (!PERMISSION_NAMES.includes(permission)) add("PERMISSION_UNKNOWN", `Unknown permission "${permission}" (allowed: ${PERMISSION_NAMES.join(", ")}).`);
  }
  const ids = new Set<string>();
  for (const command of ccb.contributes?.commands ?? []) {
    if (ids.has(command.id)) add("COMMAND_DUPLICATE", `Command "${command.id}" is declared twice.`);
    ids.add(command.id);
    if (command.key !== undefined && !legacyKey(command.key) && !/^((cmd|ctrl|alt|option|shift)\+)*[^+]+$/.test(command.key)) {
      add("SHORTCUT_UNREADABLE", `Command "${command.id}" has an unreadable shortcut "${command.key}" (for example cmd+shift+l).`);
    }
  }
  for (const panel of ccb.contributes?.panels ?? []) if (ccb.web === undefined) add("PANEL_NEEDS_WEB", `Panel "${panel.id}" needs a web part (ccb.web) to draw it.`);
  for (const [key, setting] of Object.entries(ccb.contributes?.settings ?? {})) {
    if (setting.env !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(setting.env)) add("SETTING_ENV_INVALID", `Setting "${key}": env "${setting.env}" must use uppercase letters, digits and underscores.`);
    const value = setting.default;
    switch (setting.type) {
      case "boolean":
        if (value !== undefined && typeof value !== "boolean") add("SETTING_DEFAULT_INVALID", `Setting "${key}": the default must be true or false.`);
        break;
      case "enum": {
        const options = setting.options ?? [];
        if (!options.length) add("SETTING_ENUM_NO_OPTIONS", `Setting "${key}" is an enum and needs options.`);
        if (value !== undefined && !(typeof value === "string" && options.includes(value))) add("SETTING_DEFAULT_INVALID", `Setting "${key}": the default is not one of the options.`);
        break;
      }
      case "string":
        if (value !== undefined && typeof value !== "string") add("SETTING_DEFAULT_INVALID", `Setting "${key}": the default must be text.`);
        break;
      case "number":
        if (value !== undefined && typeof value !== "number") add("SETTING_DEFAULT_INVALID", `Setting "${key}": the default must be a number.`);
        break;
      default:
        add("SETTING_TYPE_INVALID", `Setting "${key}": type "${setting.type}" must be boolean, enum, string or number.`);
    }
  }
  staticGate(folder, add);
  return issues;
}

/** The problems with a plugin folder (`PluginRegistry.check`) as plain messages; none: it may load. */
export function checkPlugin(folder: string): string[] {
  return checkPluginIssues(folder).map((issue) => issue.message);
}

// ---------------------------------------------------------------------------------------------
// Manifest v3: `botling` (or `ccb`, read as it works today) into one shape. Nothing loads by it yet.

export interface ManifestRead {
  /** The field it was read from; null when it has neither. */
  format: "botling" | "ccb" | null;
  name: string;
  version: string;
  displayName?: string;
  publisher?: string;
  /** `engines.botling`, or the older `engines.ccb`. */
  engine?: string;
  /** The program part, run in the plugin host (old `ccb.host`). */
  main?: string;
  /** The chat page's extension (old `ccb.web`, which is also `ui`). */
  chat?: string;
  /** The bundle panel, tile and card frames render with. */
  ui?: string;
  styles: string[];
  /** "lazy": on first use of a contribution; "startup": when the host starts (every old program part). */
  activation: "lazy" | "startup";
  /** What it asks to do (old `ccb.permissions`). */
  capabilities: string[];
  contributions: Contribution[];
  problems: string[];
}

/** Reads a package.json (`botling` wins over `ccb` when it has both); never throws, says what is wrong instead. */
export function readManifest(value: unknown, folder: FolderView): ManifestRead {
  const read: ManifestRead = { format: null, name: "", version: "", styles: [], activation: "lazy", capabilities: [], contributions: [], problems: [] };
  if (!isObject(value)) return { ...read, problems: ["package.json is not a JSON object."] };
  const problems = read.problems;
  const text = (object: Record<string, unknown>, key: string, label = key) => {
    const v = object[key];
    if (v == null) return undefined;
    if (typeof v === "string") return v;
    problems.push(`${label} has the wrong type.`);
    return undefined;
  };
  const texts = (object: Record<string, unknown>, key: string, label: string) => {
    const v = object[key];
    if (v == null) return [];
    if (Array.isArray(v) && v.every((item) => typeof item === "string")) return v as string[];
    problems.push(`${label} has the wrong type.`);
    return [];
  };
  read.name = text(value, "name") ?? "";
  read.version = text(value, "version") ?? "";
  if (!read.name) problems.push("name is missing.");
  if (!read.version) problems.push("version is missing.");
  for (const key of ["displayName", "publisher"] as const) { const v = text(value, key); if (v !== undefined) read[key] = v; }
  const engines = isObject(value.engines) ? value.engines : {};
  const engine = text(engines, "botling", "engines.botling") ?? text(engines, "ccb", "engines.ccb");
  if (engine !== undefined) read.engine = engine;
  const format = value.botling != null ? "botling" : value.ccb != null ? "ccb" : null;
  if (!format) { problems.push("The botling field is missing."); return read; }
  read.format = format;
  const field = value[format];
  if (!isObject(field)) { problems.push(`${format} has the wrong type.`); return read; }
  const old = format === "ccb";
  const main = text(field, old ? "host" : "main", `${format}.${old ? "host" : "main"}`);
  const web = old ? text(field, "web", "ccb.web") : undefined;
  const chat = old ? web : text(field, "chat", "botling.chat");
  const ui = old ? web : text(field, "ui", "botling.ui");
  Object.assign(read, main !== undefined ? { main } : {}, chat !== undefined ? { chat } : {}, ui !== undefined ? { ui } : {});
  read.styles = texts(field, "styles", `${format}.styles`);
  read.capabilities = texts(field, old ? "permissions" : "capabilities", old ? "ccb.permissions" : "botling.capabilities");
  if (old) read.activation = "startup";
  else if (field.activation === "startup" || field.activation === "lazy") read.activation = field.activation;
  else if (field.activation != null) problems.push(`botling.activation must be "lazy" or "startup".`);
  let claude = text(field, "claude", `${format}.claude`);
  if (claude !== undefined && !insidePlugin(claude)) { problems.push(`claude "${claude}" must be a relative path inside the plugin folder.`); claude = undefined; }
  const contributes = readContributions(read.name, field.contributes, claude, !old, folder);
  read.contributions = contributes.contributions;
  problems.push(...contributes.problems);
  return read;
}

/** A plugin folder on disk, for `readManifest`. */
export function diskFolder(root: string): FolderView {
  return {
    exists: (path) => existsSync(join(root, path)),
    read: (path) => { try { return readFileSync(join(root, path), "utf8"); } catch { return null; } },
    list: (path) => { try { return readdirSync(join(root, path)); } catch { return []; } },
  };
}

// ---------------------------------------------------------------------------------------------
// npm semver ranges, enough for `engines.ccb` (`SemverRange`): `||` alternatives of comparators that
// must all hold; `^`, `~`, x-ranges, hyphen ranges. Pre-release tags are not supported.

type Version = [number, number, number];
type Comparator = { op: "atLeast" | "above" | "below" | "atMost"; bound: Version };
const cmp = (a: Version, b: Version) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

function holds(comparator: Comparator, version: Version): boolean {
  const c = cmp(version, comparator.bound);
  switch (comparator.op) {
    case "atLeast": return c >= 0;
    case "above": return c > 0;
    case "below": return c < 0;
    case "atMost": return c <= 0;
  }
}

/** A version as written: up to three numbers, any of them a wildcard (or left out). Null for anything else. */
function partial(text: string): number[] | null {
  let rest = text;
  if (rest.startsWith("v") || rest.startsWith("=")) rest = rest.slice(1);
  if (!rest) return [];
  const numbers: (number | null)[] = [];
  for (const piece of rest.split(".")) {
    if (piece === "x" || piece === "X" || piece === "*") numbers.push(null);
    else if (/^\d+$/.test(piece)) numbers.push(Number(piece));
    else return null;
  }
  if (numbers.length > 3) return null;
  const first = numbers.indexOf(null);
  return (first >= 0 ? numbers.slice(0, first) : numbers) as number[];
}

function span(given: number[]): { low: Version; high: Version | null } {
  const low: Version = [given[0] ?? 0, given[1] ?? 0, given[2] ?? 0];
  switch (given.length) {
    case 0: return { low, high: null };
    case 1: return { low, high: [low[0] + 1, 0, 0] };
    case 2: return { low, high: [low[0], low[1] + 1, 0] };
    default: return { low, high: [low[0], low[1], low[2] + 1] };
  }
}

function comparators(text: string): Comparator[] | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 3 && tokens[1] === "-") {
    const low = partial(tokens[0]!);
    const high = partial(tokens[2]!);
    if (!low || !high) return null;
    const end = span(high).high;
    return [{ op: "atLeast", bound: span(low).low }, ...(end ? [{ op: "below" as const, bound: end }] : [])];
  }
  const joined: string[] = [];
  while (tokens.length) {
    const token = tokens.shift()!;
    if ([">", ">=", "<", "<=", "=", "^", "~"].includes(token) && tokens.length) joined.push(token + tokens.shift()!);
    else joined.push(token);
  }
  const result: Comparator[] = [];
  for (const token of joined) {
    const op = [">=", "<=", ">", "<", "^", "~", "="].find((candidate) => token.startsWith(candidate)) ?? "";
    const numbers = partial(token.slice(op.length));
    if (!numbers) return null;
    const { low, high } = span(numbers);
    const given = numbers.length;
    switch (op) {
      case "^": {
        const next: Version | null = given === 0 ? null
          : low[0] > 0 || given === 1 ? [low[0] + 1, 0, 0]
          : low[1] > 0 || given === 2 ? [0, low[1] + 1, 0]
          : [0, 0, low[2] + 1];
        result.push({ op: "atLeast", bound: low });
        if (next) result.push({ op: "below", bound: next });
        break;
      }
      case "~": {
        const next: Version | null = given === 0 ? null : given === 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0];
        result.push({ op: "atLeast", bound: low });
        if (next) result.push({ op: "below", bound: next });
        break;
      }
      case ">=": result.push({ op: "atLeast", bound: low }); break;
      case ">": result.push(high ? { op: "atLeast", bound: high } : { op: "below", bound: [0, 0, 0] }); break;
      case "<": result.push({ op: "below", bound: low }); break;
      case "<=": if (high) result.push({ op: "below", bound: high }); break;
      default:
        result.push({ op: "atLeast", bound: low });
        if (high) result.push({ op: "below", bound: high });
    }
  }
  return result;
}

/** Whether this app's plugin API (every patch of it) is in an npm semver range (`PluginRegistry.compatible`). */
export function compatible(range: string): boolean {
  const alternatives: Comparator[][] = [];
  for (const part of range.split("||")) {
    const set = comparators(part);
    if (!set) return false;
    alternatives.push(set);
  }
  const version: Version = [API_VERSION.major, API_VERSION.minor, Number.MAX_SAFE_INTEGER];
  return alternatives.some((set) => set.every((comparator) => holds(comparator, version)));
}
