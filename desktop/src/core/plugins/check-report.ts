// The plugin check's report (1.x: the Botling binary's --check-plugin), shared by the small Node
// command (check-cli.ts, development) and the app itself (`Botling --check-plugin <folder>`, which is
// what a packaged build hands Maintainer: its RunAsNode fuse is off, so Electron cannot run a script).
import { resolve } from "node:path";
import { API_VERSION, checkPluginIssues, contributionIssues, type PluginOrigin } from "./manifest";

/**
 * Exit code 0: passes; 1: problems (each on a ✗ line, followed by a `→ next [CODE]:` line saying what to do); 2: usage.
 * After them, each contribution with the plugin API it needs (`· <contribution>: API 2.x`), so a plugin can set `engines`.
 */
export function checkReport(folder: string | undefined, origin: PluginOrigin = "incoming"): { code: number; stdout: string; stderr: string } {
  if (!folder) return { code: 2, stdout: "", stderr: "usage: check-plugin <plugin folder>\n" };
  const problems = checkPluginIssues(resolve(folder), origin);
  const { needs, issues } = problems.some((issue) => issue.code === "MANIFEST_NOT_FOUND" || issue.code === "MANIFEST_MALFORMED") ? { needs: [], issues: [] } : contributionIssues(resolve(folder));
  const all = [...problems, ...issues];
  const needed = needs.length
    ? `Plugin API each contribution needs (this Botling: ${API_VERSION.major}.${API_VERSION.minor}):\n${needs.map((need) => `  · ${need.feature}: API ${need.api}\n`).join("")}`
    : "";
  if (all.length) return { code: 1, stdout: all.map((issue) => `✗ ${issue.message}\n  → next [${issue.code}]: ${issue.nextStep}\n`).join("") + needed, stderr: "" };
  return { code: 0, stdout: `✓ ${resolve(folder)} passes the checks.\n${needed}`, stderr: "" };
}
