// Site tools for the in-app browser (2026-11-10, phase 3): small scripts that act on the page of a tab (export a
// conversation, a reader layout). One folder per tool under the app's data folder, `browser-tools/<id>/` with
// `tool.json` (what it is, the sites it is for, its form) and `script.js` (what it does); bots make a tool by writing
// those two files and the app picks it up. Main runs a script in an isolated world of the page (no Node, nothing of
// the app's, the page's own scripts cannot see it) and gives it one object, `botling`, with a very narrow bridge:
// read the form, report progress, give back a result, save a file (main asks where, with a save dialog), and turn
// itself on or off for the site. Kept free of Electron and the file system so it can be tested; main/site-tools.ts
// loads the folders, browser-host.ts runs the scripts.

export const SITE_TOOL_FILE = "tool.json";
export const SITE_TOOL_SCRIPT = "script.js";
export const SITE_TOOL_SCRIPT_MAX = 256_000;
export const SITE_TOOL_MANIFEST_MAX = 16_000;
/** What one run may give back. */
export const RESULT_TEXT_MAX = 2_000;
export const RESULT_FILES_MAX = 5;
export const RESULT_FILE_MAX = 20_000_000;
export const RUN_TIMEOUT_MS = 60_000;
/** The file types a tool may save. */
export const SAVE_EXTENSIONS = ["md", "txt", "json", "csv", "html", "tsv", "xml"] as const;

export const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export type SiteToolKind = "action" | "toggle";
export type SiteToolField =
  | { id: string; label: string; type: "choice"; options: string[]; default?: string }
  | { id: string; label: string; type: "text"; default?: string; placeholder?: string }
  | { id: string; label: string; type: "check"; default?: boolean };
export type SiteToolOptions = Record<string, string | boolean>;

/** A tool as the app page shows it (no script). */
export interface SiteToolView {
  id: string;
  name: string;
  description: string;
  matches: string[];
  /** action: a Run button (and a form); toggle: a switch that stays on for the site and comes back on every load. */
  kind: SiteToolKind;
  fields: SiteToolField[];
  runLabel: string;
  builtIn: boolean;
}
export interface SiteTool extends SiteToolView { script: string }
/** A folder that is not a working tool, and why (shown in the sheet so a bot can fix it). */
export interface SiteToolProblem { id: string; error: string }

/** What is on and off, per site (the host without www.). */
export interface SiteToolSiteState {
  /** Action tools turned off for a site. */
  off: Record<string, string[]>;
  /** Toggle tools turned on for a site. */
  on: Record<string, string[]>;
}
export const emptySiteState = (): SiteToolSiteState => ({ off: {}, on: {} });

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** `tool.json` checked; `id` is the folder's name. */
export function parseSiteTool(id: string, raw: unknown, script: string, builtIn = false): { tool: SiteTool } | { error: string } {
  if (!TOOL_ID.test(id)) return { error: "the folder name must be lowercase letters, digits and dashes" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${SITE_TOOL_FILE} is not an object` };
  const m = raw as Record<string, unknown>;
  if (!text(m.name, 80)) return { error: "name: a text of 1–80 characters" };
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 400)) return { error: "description: a text of at most 400 characters" };
  if (!Array.isArray(m.matches) || m.matches.length === 0 || m.matches.length > 20) return { error: "matches: a list of 1–20 URL patterns" };
  for (const pattern of m.matches) {
    if (typeof pattern !== "string" || !compilePattern(pattern)) return { error: `matches: "${String(pattern).slice(0, 80)}" is not a URL pattern like https://example.com/* or *://*.example.com/*` };
  }
  const kind = m.kind === undefined ? "action" : m.kind;
  if (kind !== "action" && kind !== "toggle") return { error: 'kind: "action" or "toggle"' };
  if (m.runLabel !== undefined && !text(m.runLabel, 24)) return { error: "runLabel: a text of 1–24 characters" };
  const fields: SiteToolField[] = [];
  if (m.fields !== undefined) {
    if (!Array.isArray(m.fields) || m.fields.length > 8) return { error: "fields: a list of at most 8" };
    if (kind === "toggle" && m.fields.length) return { error: "fields: a toggle tool has no form" };
    for (const [index, value] of m.fields.entries()) {
      const field = parseField(value);
      if (typeof field === "string") return { error: `fields[${index}]: ${field}` };
      if (fields.some((each) => each.id === field.id)) return { error: `fields[${index}]: the id ${field.id} is used twice` };
      fields.push(field);
    }
  }
  if (typeof script !== "string" || !script.trim()) return { error: `${SITE_TOOL_SCRIPT} is missing or empty` };
  if (script.length > SITE_TOOL_SCRIPT_MAX) return { error: `${SITE_TOOL_SCRIPT} is larger than ${SITE_TOOL_SCRIPT_MAX / 1000} kB` };
  return {
    tool: {
      id, name: (m.name as string).trim(), description: typeof m.description === "string" ? m.description.trim() : "",
      matches: m.matches as string[], kind, fields, runLabel: typeof m.runLabel === "string" ? m.runLabel.trim() : kind === "toggle" ? "Turn on" : "Run",
      builtIn, script,
    },
  };
}

function parseField(raw: unknown): SiteToolField | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !FIELD_ID.test(f.id)) return "id: letters, digits and _ (starting with a letter)";
  if (!text(f.label, 60)) return "label: a text of 1–60 characters";
  const base = { id: f.id, label: (f.label as string).trim() };
  switch (f.type) {
    case "choice": {
      if (!Array.isArray(f.options) || f.options.length < 2 || f.options.length > 6 || !f.options.every((option) => text(option, 40))) return "options: 2–6 short texts";
      if (f.default !== undefined && !(f.options as string[]).includes(f.default as string)) return "default: one of the options";
      return { ...base, type: "choice", options: f.options as string[], ...(f.default !== undefined ? { default: f.default as string } : {}) };
    }
    case "text":
      if (f.default !== undefined && (typeof f.default !== "string" || f.default.length > 2_000)) return "default: a text";
      if (f.placeholder !== undefined && (typeof f.placeholder !== "string" || f.placeholder.length > 80)) return "placeholder: a short text";
      return { ...base, type: "text", ...(f.default !== undefined ? { default: f.default as string } : {}), ...(f.placeholder !== undefined ? { placeholder: f.placeholder as string } : {}) };
    case "check":
      if (f.default !== undefined && typeof f.default !== "boolean") return "default: true or false";
      return { ...base, type: "check", ...(f.default !== undefined ? { default: f.default as boolean } : {}) };
    default: return 'type: "choice", "text" or "check"';
  }
}

/** A field's starting value. */
export function fieldDefault(field: SiteToolField): string | boolean {
  if (field.type === "check") return field.default ?? false;
  if (field.type === "choice") return field.default ?? field.options[0]!;
  return field.default ?? "";
}

/** The form's values as a run gets them: only the tool's fields, each of its type, defaults for the rest. */
export function runOptions(tool: Pick<SiteToolView, "fields">, given: SiteToolOptions | undefined): SiteToolOptions {
  const out: SiteToolOptions = {};
  for (const field of tool.fields) {
    const value = given?.[field.id];
    if (field.type === "check") out[field.id] = typeof value === "boolean" ? value : fieldDefault(field);
    else if (field.type === "choice") out[field.id] = typeof value === "string" && field.options.includes(value) ? value : fieldDefault(field);
    else out[field.id] = typeof value === "string" ? value.slice(0, 2_000) : fieldDefault(field);
  }
  return out;
}

// --- URL patterns -----------------------------------------------------------------------------------------------

const escape = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * A URL pattern as browser extensions write them: `<all_urls>`, or `scheme://host/path` where scheme is http, https
 * or *, host is *, *.example.com (the domain and every subdomain) or a name, and the path may hold * anywhere.
 * A host with a port (localhost:3000) must match the port. Null: not a pattern.
 */
export function compilePattern(pattern: string): ((url: URL) => boolean) | null {
  if (pattern === "<all_urls>") return (url) => url.protocol === "http:" || url.protocol === "https:";
  if (pattern.length > 500) return null;
  const match = /^(\*|https?):\/\/(\*|(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?)(\/.*)$/i.exec(pattern);
  if (!match) return null;
  const [, scheme, hostPart, path] = match as unknown as [string, string, string, string];
  const host = hostPart.toLowerCase();
  if (host !== "*" && (host.startsWith(".") || host.includes("..") || host.endsWith("."))) return null;
  const pathRe = new RegExp(`^${path.split("*").map(escape).join(".*")}$`);
  return (url) => {
    const protocol = url.protocol.slice(0, -1);
    if (protocol !== "http" && protocol !== "https") return false;
    if (scheme !== "*" && scheme.toLowerCase() !== protocol) return false;
    if (host !== "*") {
      const [name, port] = host.split(":") as [string, string | undefined];
      if (port !== undefined && url.port !== port) return false;
      const hostname = url.hostname.toLowerCase();
      if (name.startsWith("*.")) { const base = name.slice(2); if (hostname !== base && !hostname.endsWith(`.${base}`)) return false; }
      else if (hostname !== name) return false;
    }
    return pathRe.test(`${url.pathname}${url.search}`);
  };
}

export function matchesUrl(patterns: string[], url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return patterns.some((pattern) => compilePattern(pattern)?.(parsed) === true);
}

/** The tools for a page, the site's own (a named host) before those for every site, then by name. */
export function toolsFor<T extends Pick<SiteToolView, "matches" | "name">>(tools: readonly T[], url: string): T[] {
  const general = (tool: T) => tool.matches.every((pattern) => pattern === "<all_urls>" || /^(\*|https?):\/\/\*\//.test(pattern));
  return tools.filter((tool) => matchesUrl(tool.matches, url))
    .sort((a, b) => Number(general(a)) - Number(general(b)) || a.name.localeCompare(b.name));
}

/** The site a per-site setting belongs to: the host without www. */
export function siteOf(url: string): string | null {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase().replace(/^www\./, "") : null; } catch { return null; }
}

/** Whether a tool is on for a site: an action tool unless turned off there, a toggle tool only once turned on. */
export function toolIsOn(state: SiteToolSiteState, tool: Pick<SiteToolView, "id" | "kind">, site: string): boolean {
  return tool.kind === "toggle" ? !!state.on[tool.id]?.includes(site) : !state.off[tool.id]?.includes(site);
}

/** The state with a tool turned on or off for a site (a new object). */
export function setToolOn(state: SiteToolSiteState, tool: Pick<SiteToolView, "id" | "kind">, site: string, on: boolean): SiteToolSiteState {
  const key = tool.kind === "toggle" ? "on" : "off";
  const listed = tool.kind === "toggle" ? on : !on;
  const sites = new Set(state[key][tool.id] ?? []);
  if (listed) sites.add(site); else sites.delete(site);
  const next = { ...state[key] };
  if (sites.size) next[tool.id] = [...sites].sort(); else delete next[tool.id];
  return { ...state, [key]: next };
}

/** A saved state file, checked (anything odd is dropped). */
export function parseSiteState(raw: unknown): SiteToolSiteState {
  const state = emptySiteState();
  if (!raw || typeof raw !== "object") return state;
  for (const key of ["off", "on"] as const) {
    const table = (raw as Record<string, unknown>)[key];
    if (!table || typeof table !== "object") continue;
    for (const [id, sites] of Object.entries(table as Record<string, unknown>)) {
      if (!TOOL_ID.test(id) || !Array.isArray(sites)) continue;
      const clean = sites.filter((site): site is string => typeof site === "string" && site.length > 0 && site.length <= 260).slice(0, 500);
      if (clean.length) state[key][id] = clean;
    }
  }
  return state;
}

// --- Running ----------------------------------------------------------------------------------------------------

/** The isolated world a tool runs in: its own (tools do not share globals), apart from Electron's own (999). */
export function worldIdOf(toolId: string): number {
  let hash = 0;
  for (const char of toolId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 2000 + (hash % 5000);
}

/** The global a script's progress line is kept in, inside its world (main reads it while the run lasts). */
export const PROGRESS_GLOBAL = "__botlingToolProgress";

/**
 * The code main runs in the tool's isolated world: the script as the body of an async function that gets `botling`,
 * and, when it is done, what it gave back (a plain object main checks with parseRunOutput).
 */
export function wrapScript(tool: Pick<SiteTool, "id" | "script">, input: { options: SiteToolOptions; active: boolean | null }): string {
  const given = JSON.stringify({ toolId: tool.id, options: input.options, active: input.active });
  return `(async () => {
  const given = ${given};
  const out = { result: null, files: [], active: null, error: null };
  globalThis.${PROGRESS_GLOBAL} = null;
  const botling = Object.freeze({
    toolId: given.toolId,
    options: Object.freeze(given.options),
    active: given.active,
    url: location.href,
    progress(text) { globalThis.${PROGRESS_GLOBAL} = String(text).slice(0, 200); },
    result(text) { out.result = String(text).slice(0, ${RESULT_TEXT_MAX}); },
    saveFile(name, content, type) {
      if (out.files.length >= ${RESULT_FILES_MAX}) throw new Error("at most ${RESULT_FILES_MAX} files per run");
      out.files.push({ name: String(name), content: typeof content === "string" ? content : JSON.stringify(content, null, 2), type: type == null ? null : String(type) });
    },
    setActive(on) { out.active = on === true; },
  });
  try {
    await (async (botling) => {
${tool.script}
    })(botling);
  } catch (error) {
    out.error = String((error && error.message) || error || "failed").slice(0, 500);
  }
  globalThis.${PROGRESS_GLOBAL} = null;
  return out;
})()`;
}

export interface RunFile { name: string; content: string; type: string | null }
export interface RunOutput { result: string | null; files: RunFile[]; active: boolean | null; error: string | null }

/**
 * What a run gave back, checked. A page's own scripts cannot reach the isolated world, but the page's DOM is what
 * the script read, so nothing here is trusted: sizes are capped, file names made safe, anything else dropped.
 */
export function parseRunOutput(raw: unknown): RunOutput | { invalid: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { invalid: "the script gave back nothing" };
  const m = raw as Record<string, unknown>;
  const result = m.result === null || m.result === undefined ? null : typeof m.result === "string" ? m.result.slice(0, RESULT_TEXT_MAX) : null;
  const error = typeof m.error === "string" ? m.error.slice(0, 500) : null;
  const active = typeof m.active === "boolean" ? m.active : null;
  const files: RunFile[] = [];
  if (m.files !== undefined) {
    if (!Array.isArray(m.files)) return { invalid: "files is not a list" };
    if (m.files.length > RESULT_FILES_MAX) return { invalid: `more than ${RESULT_FILES_MAX} files` };
    for (const file of m.files) {
      if (!file || typeof file !== "object") return { invalid: "a file is not an object" };
      const f = file as Record<string, unknown>;
      if (typeof f.content !== "string") return { invalid: "a file's content is not text" };
      if (f.content.length > RESULT_FILE_MAX) return { invalid: `a file is larger than ${RESULT_FILE_MAX / 1_000_000} MB` };
      const name = safeFileName(typeof f.name === "string" ? f.name : "");
      if (!name) return { invalid: `a file must be named *.${SAVE_EXTENSIONS.join(", *.")}` };
      files.push({ name, content: f.content, type: typeof f.type === "string" ? f.type.slice(0, 100) : null });
    }
  }
  return { result, files, active, error };
}

/**
 * A file name a tool asked for, made safe: no folders, no hidden files, no odd characters, at most 120 characters,
 * and one of the allowed types. Null: not allowed (no name, or another type).
 */
export function safeFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  if (!(SAVE_EXTENSIONS as readonly string[]).includes(extension)) return null;
  const stem = base.slice(0, dot)
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s]+$/g, "")
    .slice(0, 110);
  return stem ? `${stem}.${extension}` : null;
}

/** What the "Ask Botling to make a tool" button sends to the bot's chat. */
export function askForToolText(url: string, folder: string, guide: string): string {
  return [
    `Please make a site tool for this page in the app's browser: ${url}`,
    "",
    "First ask me in one line what it should do (suggest two or three ideas that fit this site).",
    `Write it as a folder in ${folder}/<tool-id>/ with tool.json and script.js, following ${guide}. The app picks it up as soon as the files are saved.`,
  ].join("\n");
}
