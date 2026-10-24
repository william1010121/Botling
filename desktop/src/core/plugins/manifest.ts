// A plugin's package.json (npm's format with a `ccb` field, like a VS Code extension) and the check
// 1.x runs on it (`PluginRegistry.check`, `ccb plugin check` without the browser parts), ported from
// Plugins.swift: the same problems, worded the same, and the same npm semver ranges for `engines.ccb`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The problems with a plugin folder (`PluginRegistry.check`); none: it may load. */
export function checkPlugin(folder: string): string[] {
  let text: string;
  try { text = readFileSync(join(folder, "package.json"), "utf8"); } catch { return ["package.json not found."]; }
  let manifest: PluginManifest;
  try {
    manifest = decodeManifest(JSON.parse(text));
  } catch (error) {
    const message = error instanceof DecodeError ? error.message : "The given data was not valid JSON.";
    return [`package.json is malformed: ${message}`];
  }
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) problems.push(`name "${manifest.name}" may only use lowercase letters, digits, - . _.`);
  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) problems.push(`version "${manifest.version}" must be semver, for example 1.0.0.`);
  const range = manifest.engines?.ccb;
  if (range === undefined) {
    problems.push(`engines.ccb is missing (for example "${ENGINE_RANGE}").`);
    return problems;
  }
  if (!compatible(range)) problems.push(`engines.ccb "${range}" is not compatible with this Botling (${API_VERSION.major}.${API_VERSION.minor}).`);
  const ccb = manifest.ccb;
  if (!ccb) {
    problems.push("The ccb field is missing.");
    return problems;
  }
  for (const [label, path] of [["web", ccb.web], ["host", ccb.host], ["claude", ccb.claude], ["contributes.components", ccb.contributes?.components]] as const) {
    if (path === undefined) continue;
    if (!inside(path)) problems.push(`${label} "${path}" must be a relative path inside the plugin folder.`);
    else if (!existsSync(join(folder, path))) problems.push(`${label} points to "${path}", which does not exist.`);
  }
  if (ccb.claude !== undefined && !existsSync(join(folder, ccb.claude, ".claude-plugin", "plugin.json"))) {
    problems.push(`The Claude part "${ccb.claude}" must contain .claude-plugin/plugin.json.`);
  }
  for (const style of ccb.styles ?? []) if (!inside(style) || !existsSync(join(folder, style))) problems.push(`"${style}" in styles does not exist.`);
  for (const permission of ccb.permissions ?? []) {
    if (!PERMISSION_NAMES.includes(permission)) problems.push(`Unknown permission "${permission}" (allowed: ${PERMISSION_NAMES.join(", ")}).`);
  }
  const ids = new Set<string>();
  for (const command of ccb.contributes?.commands ?? []) {
    if (ids.has(command.id)) problems.push(`Command "${command.id}" is declared twice.`);
    ids.add(command.id);
    if (command.key !== undefined && !/^((cmd|ctrl|alt|option|shift)\+)*[^+]+$/.test(command.key)) {
      problems.push(`Command "${command.id}" has an unreadable shortcut "${command.key}" (for example cmd+shift+l).`);
    }
  }
  for (const panel of ccb.contributes?.panels ?? []) if (ccb.web === undefined) problems.push(`Panel "${panel.id}" needs a web part (ccb.web) to draw it.`);
  for (const [key, setting] of Object.entries(ccb.contributes?.settings ?? {})) {
    if (setting.env !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(setting.env)) problems.push(`Setting "${key}": env "${setting.env}" must use uppercase letters, digits and underscores.`);
    const value = setting.default;
    switch (setting.type) {
      case "boolean":
        if (value !== undefined && typeof value !== "boolean") problems.push(`Setting "${key}": the default must be true or false.`);
        break;
      case "enum": {
        const options = setting.options ?? [];
        if (!options.length) problems.push(`Setting "${key}" is an enum and needs options.`);
        if (value !== undefined && !(typeof value === "string" && options.includes(value))) problems.push(`Setting "${key}": the default is not one of the options.`);
        break;
      }
      case "string":
        if (value !== undefined && typeof value !== "string") problems.push(`Setting "${key}": the default must be text.`);
        break;
      case "number":
        if (value !== undefined && typeof value !== "number") problems.push(`Setting "${key}": the default must be a number.`);
        break;
      default:
        problems.push(`Setting "${key}": type "${setting.type}" must be boolean, enum, string or number.`);
    }
  }
  return problems;
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
