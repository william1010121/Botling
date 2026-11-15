// The plugin check's report (1.x: the Botling binary's --check-plugin), shared by the small Node
// command (check-cli.ts, development) and the app itself (`Botling --check-plugin <folder>`, which is
// what a packaged build hands Maintainer: its RunAsNode fuse is off, so Electron cannot run a script).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_VERSION, checkPluginIssues, contributionIssues, isShippedBuiltIn, type PluginOrigin } from "./manifest";

/**
 * `builtIns`: the app's built-in plugins folder; a folder whose name is one of them is checked as a library override of it.
 * Exit code 0: passes; 1: problems (each on a ✗ line, followed by a `→ next [CODE]:` line saying what to do); 2: usage.
 * After them, each contribution with the plugin API it needs (`· <contribution>: API 2.x`), so a plugin can set `engines`.
 */
export function checkReport(folder: string | undefined, origin: PluginOrigin = "incoming", builtIns: string | null = null): { code: number; stdout: string; stderr: string } {
  if (!folder) return { code: 2, stdout: "", stderr: "usage: check-plugin <plugin folder>\n" };
  // A copy of a plugin the app ships (`builtIns`), made to override it, keeps the shipped name; any other name gets `origin`'s rule.
  let name: unknown;
  try { name = (JSON.parse(readFileSync(join(resolve(folder), "package.json"), "utf8")) as { name?: unknown }).name; } catch { /* the check says why */ }
  const rule: PluginOrigin = origin === "incoming" && typeof name === "string" && isShippedBuiltIn(builtIns, name) ? "library" : origin;
  const problems = checkPluginIssues(resolve(folder), rule);
  const { needs, issues } = problems.some((issue) => issue.code === "MANIFEST_NOT_FOUND" || issue.code === "MANIFEST_MALFORMED") ? { needs: [], issues: [] } : contributionIssues(resolve(folder));
  const all = [...problems, ...issues];
  const needed = needs.length
    ? `Plugin API each contribution needs (this Botling: ${API_VERSION.major}.${API_VERSION.minor}):\n${needs.map((need) => `  · ${need.feature}: API ${need.api}\n`).join("")}`
    : "";
  if (all.length) return { code: 1, stdout: all.map((issue) => `✗ ${issue.message}\n  → next [${issue.code}]: ${issue.nextStep}\n`).join("") + needed, stderr: "" };
  return { code: 0, stdout: `✓ ${resolve(folder)} passes the checks.\n${needed}`, stderr: "" };
}
