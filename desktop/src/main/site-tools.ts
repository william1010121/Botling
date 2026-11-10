// The site tools on disk (browser-site-tools.ts): the built-ins, then one folder per tool under
// `<data>/browser-tools/<id>/` (tool.json + script.js), loaded again whenever a file there changes (a bot writing
// a tool), and what is on and off per site (`<data>/browser-tools-state.json`). Node only, no Electron, so it can
// be tested; browser-host.ts runs the tools.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  SITE_TOOL_FILE, SITE_TOOL_MANIFEST_MAX, SITE_TOOL_SCRIPT, SITE_TOOL_SCRIPT_MAX, TOOL_ID, emptySiteState, parseSiteState, parseSiteTool, setToolOn,
  type SiteTool, type SiteToolProblem, type SiteToolSiteState, type SiteToolView,
} from "../browser-site-tools";
import { BUILT_IN_SITE_TOOLS, type BuiltInSiteTool } from "./site-tools-builtin";

export const SITE_TOOLS_GUIDE = "README.md";

export interface SiteToolCatalog { tools: SiteToolView[]; problems: SiteToolProblem[]; state: SiteToolSiteState; folder: string; guide: string }

/** Every tool in a folder, checked, after the built-ins (a folder of the same id takes a built-in's place). */
export function loadSiteTools(folder: string, builtIns: readonly BuiltInSiteTool[] = BUILT_IN_SITE_TOOLS): { tools: SiteTool[]; problems: SiteToolProblem[] } {
  const byId = new Map<string, SiteTool>();
  const problems: SiteToolProblem[] = [];
  for (const builtIn of builtIns) {
    const parsed = parseSiteTool(builtIn.id, builtIn.manifest, builtIn.script, true);
    if ("tool" in parsed) byId.set(builtIn.id, parsed.tool);
    else problems.push({ id: builtIn.id, error: parsed.error });
  }
  let names: string[] = [];
  try { names = readdirSync(folder).sort(); } catch { /* no folder yet */ }
  for (const name of names) {
    if (name.startsWith(".") || name === SITE_TOOLS_GUIDE) continue;
    const dir = join(folder, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!TOOL_ID.test(name)) { problems.push({ id: name.slice(0, 64), error: "the folder name must be lowercase letters, digits and dashes" }); continue; }
    const manifestPath = join(dir, SITE_TOOL_FILE);
    const scriptPath = join(dir, SITE_TOOL_SCRIPT);
    // A tool being written has its folder before its files: say nothing until tool.json is there.
    if (!existsSync(manifestPath)) continue;
    try {
      if (statSync(manifestPath).size > SITE_TOOL_MANIFEST_MAX) { problems.push({ id: name, error: `${SITE_TOOL_FILE} is too large` }); continue; }
      if (existsSync(scriptPath) && statSync(scriptPath).size > SITE_TOOL_SCRIPT_MAX) { problems.push({ id: name, error: `${SITE_TOOL_SCRIPT} is too large` }); continue; }
      let manifest: unknown;
      try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (error) { problems.push({ id: name, error: `${SITE_TOOL_FILE} is not valid JSON (${(error as Error).message.slice(0, 120)})` }); continue; }
      const script = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
      const parsed = parseSiteTool(name, manifest, script, false);
      if ("tool" in parsed) byId.set(name, parsed.tool);
      else problems.push({ id: name, error: parsed.error });
    } catch (error) {
      problems.push({ id: name, error: `cannot be read (${(error as Error).message.slice(0, 120)})` });
    }
  }
  return { tools: [...byId.values()], problems };
}

export interface SiteToolStoreOptions {
  folder: string;
  stateFile: string;
  /** The format, written to the folder as README.md for bots. */
  guide?: string;
  note?(text: string): void;
  /** Tests: no file watcher. */
  watch?: boolean;
  debounceMs?: number;
}

/** The tools of the app, shared by every window. */
export class SiteToolStore {
  private tools: SiteTool[] = [];
  private problems: SiteToolProblem[] = [];
  private state: SiteToolSiteState = emptySiteState();
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SiteToolStoreOptions) {
    try {
      mkdirSync(options.folder, { recursive: true });
      if (options.guide !== undefined) {
        const guide = join(options.folder, SITE_TOOLS_GUIDE);
        let current: string | null = null;
        try { current = readFileSync(guide, "utf8"); } catch { /* not yet */ }
        if (current !== options.guide) writeFileSync(guide, options.guide);
      }
    } catch (error) { options.note?.(`site tools: cannot prepare ${options.folder} (${(error as Error).message})`); }
    try { this.state = parseSiteState(JSON.parse(readFileSync(options.stateFile, "utf8"))); } catch { /* none saved yet */ }
    this.reload();
    if (options.watch !== false) this.startWatching();
  }

  /** Loads the folder again and tells everyone. */
  reload(): void {
    const loaded = loadSiteTools(this.options.folder);
    this.tools = loaded.tools;
    this.problems = loaded.problems;
    for (const problem of loaded.problems) this.options.note?.(`site tools: ${problem.id}: ${problem.error}`);
    this.emit();
  }

  tool(id: string): SiteTool | null { return this.tools.find((tool) => tool.id === id) ?? null; }
  all(): readonly SiteTool[] { return this.tools; }
  siteState(): SiteToolSiteState { return this.state; }

  catalog(): SiteToolCatalog {
    return {
      tools: this.tools.map(({ script: _script, ...view }) => view),
      problems: this.problems,
      state: this.state,
      folder: this.options.folder,
      guide: join(this.options.folder, SITE_TOOLS_GUIDE),
    };
  }

  setOn(toolId: string, site: string, on: boolean): void {
    const tool = this.tool(toolId);
    if (!tool) return;
    this.state = setToolOn(this.state, tool, site, on);
    try { writeFileSync(this.options.stateFile, `${JSON.stringify(this.state, null, 2)}\n`); } catch (error) { this.options.note?.(`site tools: cannot save ${this.options.stateFile} (${(error as Error).message})`); }
    this.emit();
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.options.folder, { recursive: true }, (_event, name) => {
        if (name && String(name) === SITE_TOOLS_GUIDE) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.reload(); }, this.options.debounceMs ?? 300);
      });
      this.watcher.on("error", (error) => this.options.note?.(`site tools: watcher stopped (${error.message})`));
    } catch (error) { this.options.note?.(`site tools: cannot watch ${this.options.folder} (${(error as Error).message})`); }
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}
