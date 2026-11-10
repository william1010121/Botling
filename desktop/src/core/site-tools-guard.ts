// Browser site tools (<data>/browser-tools/, main/site-tools.ts) are made and kept by Maintainer alone (approved
// 2026-11-10), so every bot reuses the same tools instead of each keeping its own. Every other bot's Claude head and
// its Claude workers carry a PreToolUse hook (head.ts `SITE_TOOLS_GUARD_HOOK`) that denies Edit/Write/MultiEdit/
// NotebookEdit into that folder and Bash commands that name it and clearly write (redirection, rm/mv/cp/mkdir/tee/…,
// sed -i). Reading stays open. Best effort like spec-guard.ts: a path built at run time is not caught, and Codex and
// Antigravity sessions are told the rule (prompts.ts `SITE_TOOLS_RULE`) but not hooked.

import { realpathSync } from "node:fs";
import { dirname, basename, join, relative, resolve, isAbsolute, sep } from "node:path";
import { shellWritesUnder } from "./spec-guard";

/** The site tools folder's name in Botling's data folder. */
export const SITE_TOOLS_FOLDER = "browser-tools";
export const SITE_TOOLS_DENIED = "Browser site tools are made and kept only by Maintainer, so every bot can reuse them; this session may read the site tools folder but not write it. Leave it as it is: a bot ends its reply with <plugin>site tool: what it should do, on which page (its URL)</plugin>; a worker says in its report that a site tool is needed.";

/**
 * The site tools folder the app reads (main.ts `SiteToolStore`): in the app's data folder, which is the parent of the
 * core's own (`BOTLING_DATA_DIR` is <app data>/core). Without the app around it, the core's data folder.
 */
export function siteToolsFolder(coreDataDir: string, appDataDir: string | null | undefined): string {
  return join(appDataDir || coreDataDir, SITE_TOOLS_FOLDER);
}

const FILE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Whether `path` (absolute, or relative to `cwd`) is the site tools folder or inside it. */
export function inSiteTools(path: string, folder: string, cwd: string): boolean {
  if (!path.trim()) return false;
  const target = resolve(cwd, path.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const roots = [...new Set([resolve(folder), real(resolve(folder))])];
  return [target, real(target)].some((candidate) => roots.some((root) => under(candidate, root)));
}

/** The hook answer: deny a write into the site tools folder; {} lets the call go on. */
export function siteToolsGuardDecision(input: any, guard: { folder: string; cwd: string }): Record<string, unknown> {
  if (input?.hook_event_name !== "PreToolUse") return {};
  const tool = String(input.tool_name ?? "");
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const inside = (path: string) => inSiteTools(path, guard.folder, guard.cwd);
  let writes = false;
  if (FILE_EDIT_TOOLS.has(tool)) {
    const path = [args.file_path, args.notebook_path, args.path].find((value): value is string => typeof value === "string" && !!value.trim());
    writes = !!path && inside(path);
  } else if (tool === "Bash" && typeof args.command === "string") {
    writes = shellWritesUnder(args.command, guard.cwd, (path, here) => inSiteTools(path, guard.folder, here), /browser-tools/);
  }
  return writes ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: SITE_TOOLS_DENIED } } : {};
}

function under(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The real path of `path`, or of its nearest existing parent with the rest appended. */
function real(path: string): string {
  try { return realpathSync(path); } catch { /* not there yet */ }
  const up = dirname(path);
  return up === path ? path : join(real(up), basename(path));
}
