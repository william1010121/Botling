// A plugin's contribution points (plugin-platform.md §3.3): every way it adds to Botling, as one flat
// list read from `botling.contributes` or the older `ccb.contributes` (`readManifest` in manifest.ts).
// Pure: the plugin's folder is seen through a `FolderView`, so the registry reads the disk and tests a
// folder in memory. Nothing acts on the list yet (step M3); later steps move commands, keybindings,
// slash, views, tiles and the agent parts onto it. Old shapes are read as they work today:
// `panels` are views in the right panel, a command's `key` is a keybinding, a component folder is a
// card and a tile of the same name, and `ccb.claude` (a Claude Code plugin folder) is an agent part.
import { posix } from "node:path";
import { aboutSizes, spelledSize } from "../components/library";
import type { JSONValue, PluginSetting } from "./manifest";

/** A plugin folder as `readManifest` sees it; paths are relative to it and "/"-separated. */
export interface FolderView {
  exists(path: string): boolean;
  read(path: string): string | null;
  /** The names in a folder (none when it is not one). */
  list(path: string): string[];
}

export const VIEW_SLOTS = ["rightPanel", "main", "window"] as const;
export const TILE_SURFACES = ["board", "whiteboard", "pin"] as const;
export const STATUS_SLOTS = ["chatHeader", "botRow"] as const;
export const MENU_SLOTS = ["message/context", "bot/context", "composer/plus", "commandPalette"] as const;
export const HOOKS = ["beforeSend", "afterReply", "toolCall"] as const;
export type ViewSlot = (typeof VIEW_SLOTS)[number];
export type TileSurface = (typeof TILE_SURFACES)[number];

/** The component folder (`template.html`, `about.md`) a card or tile comes from; `name` is what `<show name>` uses. */
export interface ComponentRef { name: string; dir: string }

export type Contribution = { plugin: string } & (
  | { kind: "command"; id: string; title: string }
  | { kind: "keybinding"; command: string; key: string }
  | { kind: "slash"; name: string; about: string; command: string }
  | { kind: "view"; id: string; title: string; icon?: string; where: ViewSlot }
  | { kind: "tile"; id: string; title: string; sizes: string[]; surfaces: TileSurface[]; component?: ComponentRef }
  | { kind: "card"; id: string; title: string; component?: ComponentRef }
  | { kind: "statusItem"; id: string; where: (typeof STATUS_SLOTS)[number] }
  | { kind: "setting"; key: string; setting: PluginSetting }
  | { kind: "menu"; menu: (typeof MENU_SLOTS)[number]; command: string }
  | { kind: "hook"; hook: (typeof HOOKS)[number] }
  | { kind: "routine"; id: string; cron: string; command: string }
  /** Skills (a folder with SKILL.md each), agent definitions and MCP servers for every engine; `claude` is the old Claude Code plugin folder. */
  | { kind: "agent"; claude: string | null; mcp: string | null; skills: { name: string; dir: string }[]; agents: { name: string; file: string }[] }
);
export type ContributionKind = Contribution["kind"];

export const ofKind = <K extends ContributionKind>(list: Contribution[], kind: K) =>
  list.filter((contribution): contribution is Extract<Contribution, { kind: K }> => contribution.kind === kind);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const insidePlugin = (path: string) => !path.startsWith("/") && !path.split("/").includes("..");
const visible = (folder: FolderView, path: string) => folder.list(path).filter((name) => !name.startsWith(".")).sort();

/**
 * The contributions in a manifest's `contributes` (and its `claude` folder), with what is wrong. An entry
 * that is wrong is left out. `owned`: ids must start with "<plugin>." (botling manifests; old ones are
 * read as they are, since some settings never had the prefix).
 */
export function readContributions(plugin: string, contributes: unknown, claude: string | undefined, owned: boolean, folder: FolderView): { contributions: Contribution[]; problems: string[] } {
  const out: Contribution[] = [];
  const problems: string[] = [];
  const c = contributes ?? {};
  if (!isObject(c)) return { contributions: claude === undefined ? [] : [agentPart(plugin, claude, {}, folder)], problems: ["contributes has the wrong type."] };

  const list = (key: string): Record<string, unknown>[] => {
    if (c[key] == null) return [];
    if (!Array.isArray(c[key])) { problems.push(`contributes.${key} has the wrong type.`); return []; }
    return (c[key] as unknown[]).flatMap((item, index) => {
      if (isObject(item)) return [item];
      problems.push(`contributes.${key}.${index} has the wrong type.`);
      return [];
    });
  };
  /** The string fields of an entry (optional ones end in "?"), or null after saying what is missing. */
  const fields = <F extends string>(entry: Record<string, unknown>, path: string, names: F[]): Record<F extends `${infer N}?` ? N : F, string> | null => {
    const values: Record<string, string> = {};
    for (const spec of names) {
      const name = spec.replace(/\?$/, "");
      const value = entry[name];
      if (value == null && spec.endsWith("?")) continue;
      if (typeof value !== "string") { problems.push(`${path} ${value == null ? "is missing" : "has the wrong type for"} ${name}.`); return null; }
      values[name] = value;
    }
    return values as never;
  };
  const seen = new Map<string, Set<string>>();
  /** Whether an id may be used: the plugin's prefix (when `owned`) and not declared twice. */
  const ownId = (label: string, id: string) => {
    if (owned && !id.startsWith(`${plugin}.`)) { problems.push(`${label} "${id}" must start with "${plugin}.".`); return false; }
    const ids = seen.get(label) ?? new Set<string>();
    seen.set(label, ids);
    if (ids.has(id)) { problems.push(`${label} "${id}" is declared twice.`); return false; }
    ids.add(id);
    return true;
  };
  const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T | null =>
    value === undefined ? fallback : (allowed as readonly string[]).includes(value) ? value as T : null;
  const named = (values: readonly string[]) => values.slice(0, -1).join(", ") + " or " + values.at(-1);

  const commands = list("commands");
  commands.forEach((entry, index) => {
    const f = fields(entry, `contributes.commands.${index}`, ["id", "title"]);
    if (f && ownId("Command", f.id)) out.push({ kind: "command", plugin, id: f.id, title: f.title });
  });
  // An old command's own shortcut (`key`), then the keybindings.
  commands.forEach((entry) => { if (typeof entry.id === "string" && typeof entry.key === "string") out.push({ kind: "keybinding", plugin, command: entry.id, key: entry.key }); });
  list("keybindings").forEach((entry, index) => {
    const f = fields(entry, `contributes.keybindings.${index}`, ["command", "key"]);
    if (f) out.push({ kind: "keybinding", plugin, command: f.command, key: f.key });
  });
  list("slash").forEach((entry, index) => {
    const f = fields(entry, `contributes.slash.${index}`, ["name", "about", "command"]);
    if (f) out.push({ kind: "slash", plugin, name: f.name, about: f.about, command: f.command });
  });
  for (const key of ["panels", "views"]) list(key).forEach((entry, index) => {
    const f = fields(entry, `contributes.${key}.${index}`, ["id", "title", "icon?", "where?"]);
    if (!f) return;
    const where = oneOf(VIEW_SLOTS, f.where, "rightPanel");
    if (!where) { problems.push(`View "${f.id}": where "${f.where}" must be ${named(VIEW_SLOTS)}.`); return; }
    if (ownId("View", f.id)) out.push({ kind: "view", plugin, id: f.id, title: f.title, ...(f.icon !== undefined ? { icon: f.icon } : {}), where });
  });
  list("tiles").forEach((entry, index) => {
    const f = fields(entry, `contributes.tiles.${index}`, ["id", "title"]);
    if (!f) return;
    const sizes: string[] = [];
    for (const size of Array.isArray(entry.sizes) ? entry.sizes : ["2x2"]) {
      const spelled = typeof size === "string" ? spelledSize(size) : null;
      if (!spelled) { problems.push(`Tile "${f.id}": size "${String(size)}" is not a Board size (for example 2x1).`); return; }
      if (!sizes.includes(spelled)) sizes.push(spelled);
    }
    const surfaces = Array.isArray(entry.surfaces) ? entry.surfaces : [...TILE_SURFACES];
    const unknown = surfaces.find((surface) => !(TILE_SURFACES as readonly unknown[]).includes(surface));
    if (unknown !== undefined) { problems.push(`Tile "${f.id}": surface "${String(unknown)}" must be ${named(TILE_SURFACES)}.`); return; }
    if (ownId("Tile", f.id)) out.push({ kind: "tile", plugin, id: f.id, title: f.title, sizes, surfaces: surfaces as TileSurface[] });
  });
  list("cards").forEach((entry, index) => {
    const f = fields(entry, `contributes.cards.${index}`, ["id", "title"]);
    if (f && ownId("Card", f.id)) out.push({ kind: "card", plugin, id: f.id, title: f.title });
  });
  // A folder of components: each is a card (`<show>`) and a tile (Board, whiteboard, pin), as today.
  const components = path(c, "components");
  if (components) for (const name of visible(folder, components)) {
    const dir = posix.join(components, name);
    if (!folder.exists(`${dir}/template.html`)) continue;
    const component = { name, dir };
    out.push({ kind: "card", plugin, id: `${plugin}.${name}`, title: name, component });
    out.push({ kind: "tile", plugin, id: `${plugin}.${name}`, title: name, sizes: aboutSizes(folder.read(`${dir}/about.md`) ?? ""), surfaces: [...TILE_SURFACES], component });
  }
  list("statusItems").forEach((entry, index) => {
    const f = fields(entry, `contributes.statusItems.${index}`, ["id", "where?"]);
    if (!f) return;
    const where = oneOf(STATUS_SLOTS, f.where, "chatHeader");
    if (!where) { problems.push(`Status item "${f.id}": where "${f.where}" must be ${named(STATUS_SLOTS)}.`); return; }
    if (ownId("Status item", f.id)) out.push({ kind: "statusItem", plugin, id: f.id, where });
  });
  if (c.settings != null) {
    if (!isObject(c.settings)) problems.push("contributes.settings has the wrong type.");
    else for (const [key, raw] of Object.entries(c.settings)) {
      const setting = isObject(raw) ? fields(raw, `Setting "${key}"`, ["type", "title"]) : (problems.push(`contributes.settings.${key} has the wrong type.`), null);
      if (!setting || !ownId("Setting", key)) continue;
      const entry = raw as Record<string, unknown>;
      const value: PluginSetting = { type: setting.type, ...(entry.default != null ? { default: entry.default as JSONValue } : {}), title: setting.title };
      if (Array.isArray(entry.options)) value.options = entry.options.filter((option): option is string => typeof option === "string");
      if (typeof entry.secret === "boolean") value.secret = entry.secret;
      if (typeof entry.env === "string") value.env = entry.env;
      out.push({ kind: "setting", plugin, key, setting: value });
    }
  }
  if (c.menus != null) {
    if (!isObject(c.menus)) problems.push("contributes.menus has the wrong type.");
    else for (const [menu, items] of Object.entries(c.menus)) {
      if (!(MENU_SLOTS as readonly string[]).includes(menu)) { problems.push(`Menu "${menu}" is not one of ${MENU_SLOTS.join(", ")}.`); continue; }
      for (const [index, item] of (Array.isArray(items) ? items : [items]).entries()) {
        const f = isObject(item) ? fields(item, `contributes.menus.${menu}.${index}`, ["command"]) : (problems.push(`contributes.menus.${menu}.${index} has the wrong type.`), null);
        if (f) out.push({ kind: "menu", plugin, menu: menu as (typeof MENU_SLOTS)[number], command: f.command });
      }
    }
  }
  if (c.hooks != null) {
    if (!Array.isArray(c.hooks)) problems.push("contributes.hooks has the wrong type.");
    else for (const hook of c.hooks) {
      if ((HOOKS as readonly unknown[]).includes(hook)) out.push({ kind: "hook", plugin, hook: hook as (typeof HOOKS)[number] });
      else problems.push(`Hook "${String(hook)}" must be ${named(HOOKS)}.`);
    }
  }
  list("routines").forEach((entry, index) => {
    const f = fields(entry, `contributes.routines.${index}`, ["id", "cron", "command"]);
    if (f && ownId("Routine", f.id)) out.push({ kind: "routine", plugin, id: f.id, cron: f.cron, command: f.command });
  });
  // Skills and agents as provider-layer.md §8.4 names them (`contributes.skills`, `contributes.agents`).
  const agent = { skills: path(c, "skills"), agents: path(c, "agents"), mcp: path(c, "mcp") };
  if (claude !== undefined || agent.skills || agent.agents || agent.mcp) out.push(agentPart(plugin, claude ?? null, agent, folder));
  return { contributions: out, problems };

  /** A folder or file the manifest names, when it is a relative path inside the plugin. */
  function path(object: Record<string, unknown>, key: string): string | null {
    const value = object[key];
    if (value == null) return null;
    if (typeof value !== "string") { problems.push(`contributes.${key} has the wrong type.`); return null; }
    if (!insidePlugin(value)) { problems.push(`contributes.${key} "${value}" must be a relative path inside the plugin folder.`); return null; }
    return posix.normalize(value).replace(/\/+$/, "");
  }
}

/** The agent part: a Claude Code plugin folder's skills/, agents/ and .mcp.json, and the folders the manifest names. */
function agentPart(plugin: string, claude: string | null, named: { skills?: string | null; agents?: string | null; mcp?: string | null }, folder: FolderView): Contribution {
  const skillDirs = [claude && posix.join(claude, "skills"), named.skills].filter((dir): dir is string => !!dir);
  const agentDirs = [claude && posix.join(claude, "agents"), named.agents].filter((dir): dir is string => !!dir);
  const claudeMcp = claude ? posix.join(claude, ".mcp.json") : null;
  return {
    kind: "agent", plugin, claude,
    mcp: named.mcp ?? (claudeMcp && folder.exists(claudeMcp) ? claudeMcp : null),
    skills: skillDirs.flatMap((dir) => visible(folder, dir).filter((name) => folder.exists(`${dir}/${name}/SKILL.md`)).map((name) => ({ name, dir: `${dir}/${name}` }))),
    agents: agentDirs.flatMap((dir) => visible(folder, dir).filter((name) => name.endsWith(".md")).map((name) => ({ name: name.slice(0, -3), file: `${dir}/${name}` }))),
  };
}
